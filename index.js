const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const axios = require('axios'); // Potřebujeme pro volání API
const { google } = require('googleapis');
require('dotenv').config();

// ===== KONFIGURACE SYSTÉMU PŘIHLÁŠEK =====
const CONFIG = {
    APPLICATION_CHANNEL_ID: '1418605324394303519', // Kanál s embedem přihlášek
    ADMIN_ROLE_ID: '1418603886218051635', // ⭐ Vedení
    EMPLOYEE_ROLE_ID: '1418604088693882900', // 👔 Zaměstnanec
    CATEGORY_ID: '1418606519494246400', // Kategorie pro ticket kanály s přihláškami
    DISPATCHER_CHANNEL_ID: '1418624695829532764', // Kanál pro zprávy o jízdách (dispatcher)
    
    // Role pozic (budete muset přidat skutečné ID rolí)
    STROJVUDCE_ROLE_ID: '1418875308811223123', // 🚂 Strojvůdce
    VYPRAVCI_ROLE_ID: '1418875376855158825' // 🚉 Výpravčí
};

// ===== GOOGLE SHEETS KONFIGURACE =====
const SHEETS_CONFIG = {
    SPREADSHEET_ID: process.env.GOOGLE_SHEETS_ID, // ID vaší tabulky
    RANGE: 'List 1!A:H' // Rozsah pro zápis dat
};

// Autentifikace pro Google Sheets
let sheetsAuth = null;
let sheets = null;

async function initializeGoogleSheets() {
    try {
        console.log('🔍 Začátek inicializace Google Sheets...');
        
        if (!process.env.GOOGLE_CREDENTIALS) {
            console.log('⚠️ Google Sheets credentials nejsou nastavené');
            return false;
        }
        
        console.log('🔍 Parsing JSON credentials...');
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
        console.log('✅ JSON credentials úspěšně parsovány');
        
        console.log('🔍 Vytvářím Google Auth...');
        sheetsAuth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        console.log('✅ Google Auth vytvořen');

        console.log('🔍 Vytvářím Sheets API klienta...');
        sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
        console.log('✅ Google Sheets připojeno úspěšně!');
        return true;
    } catch (error) {
        console.error('❌ Chyba při připojování k Google Sheets:', error.message);
        return false;
    }
}

// Funkce pro zápis jízdy do Google Sheets
async function zapisiJizduDoSheets(jizda, userName) {
    try {
        if (!sheets || !SHEETS_CONFIG.SPREADSHEET_ID) {
            console.log('⚠️ Google Sheets není nakonfigurováno');
            return false;
        }

        const datum = new Date().toLocaleDateString('cs-CZ');
        const cas = new Date().toLocaleTimeString('cs-CZ');
        
        const radek = [
            datum,                    // A - Datum
            cas,                      // B - Čas
            userName,                 // C - Uživatel
            jizda.vlakCislo,         // D - Vlak
            jizda.trasa,             // E - Trasa
            jizda.doba + ' min',     // F - Doba trvání
            jizda.body,              // G - Body
            '' // H - Poznámky (prázdné)
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEETS_CONFIG.SPREADSHEET_ID,
            range: SHEETS_CONFIG.RANGE,
            valueInputOption: 'RAW',
            requestBody: {
                values: [radek]
            }
        });

        console.log(`✅ Jízda ${jizda.vlakCislo} zapsána do Google Sheets`);
        return true;
    } catch (error) {
        console.error('❌ Chyba při zápisu do Google Sheets:', error);
        return false;
    }
}

// Úložiště pro aktivní přihlášky
const activeApplications = new Map();

// ===== DATABÁZE PRO SLEDOVÁNÍ JÍZD =====
const aktivniJizdy = new Map(); // userId -> { vlakCislo, startCas, startStanice, cilStanice, trainName }
const dokonceneJizdy = new Map(); // userId -> [ {vlakCislo, startCas, konecCas, doba, trasa, body} ]
const userStats = new Map(); // userId -> { celkoveBody, uroven, streak, posledniJizda }

// Bodovací systém
const BODOVANI = {
    ZAKLADNI_BODY: 10,
    BONUS_ZA_5MIN: 1,
    BONUS_DLOUHA_JIZDA: 5, // nad 60 minut
    STREAK_BONUS: 2,
    DENNI_BONUS: 5,
    VIP_BONUS: 10
};

const UROVNE = [
    { nazev: "🥉 Začátečník", min: 0, max: 99 },
    { nazev: "🥈 Zkušený", min: 100, max: 299 },
    { nazev: "🥇 Expert", min: 300, max: 599 },
    { nazev: "💎 Mistr", min: 600, max: 9999 }
];

// Funkce pro získání uživatelských statistik
function getUserStats(userId) {
    if (!userStats.has(userId)) {
        userStats.set(userId, {
            celkoveBody: 0,
            uroven: "🥉 Začátečník",
            streak: 0,
            posledniJizda: null,
            celkoveJizdy: 0,
            celkovyCas: 0
        });
    }
    return userStats.get(userId);
}

// Funkce pro výpočet bodů
function vypocitejBody(dobaTrvani, trainName = "", isStreak = false, isDenni = false) {
    let body = BODOVANI.ZAKLADNI_BODY;
    
    // Časový bonus
    body += Math.floor(dobaTrvani / 5) * BODOVANI.BONUS_ZA_5MIN;
    
    // Bonus za dlouhou jízdu
    if (dobaTrvani >= 60) {
        body += BODOVANI.BONUS_DLOUHA_JIZDA;
    }
    
    // VIP vlaky bonus
    if (trainName && (trainName.includes('IC') || trainName.includes('EC') || trainName.includes('RJ'))) {
        body += BODOVANI.VIP_BONUS;
    }
    
    // Streak bonus
    if (isStreak) {
        body += BODOVANI.STREAK_BONUS;
    }
    
    // Denní bonus
    if (isDenni) {
        body += BODOVANI.DENNI_BONUS;
    }
    
    return body;
}

// Funkce pro aktualizaci úrovně
function aktualizujUroven(userId, novyPocetBodu) {
    const stats = getUserStats(userId);
    stats.celkoveBody = novyPocetBodu;
    
    for (const uroven of UROVNE) {
        if (novyPocetBodu >= uroven.min && novyPocetBodu <= uroven.max) {
            stats.uroven = uroven.nazev;
            break;
        }
    }
    
    return stats.uroven;
}

// ===== REGISTRACE SLASH PŘÍKAZŮ =====
const commands = [
    new SlashCommandBuilder()
        .setName('oznámení')
        .setDescription('Pošle hezké oznámení do vybraného kanálu (pouze pro adminy)')
        .addChannelOption(option =>
            option.setName('kanál')
                .setDescription('Kanál kam poslat oznámení')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText)
        )
        .addStringOption(option =>
            option.setName('text')
                .setDescription('Text oznámení')
                .setRequired(true)
                .setMaxLength(2000)
        )
        .addStringOption(option =>
            option.setName('barva')
                .setDescription('Barva embedu')
                .setRequired(false)
                .addChoices(
                    { name: '🔵 Modrá (info)', value: '#0099ff' },
                    { name: '🟢 Zelená (úspěch)', value: '#00ff00' },
                    { name: '🟡 Žlutá (upozornění)', value: '#ffcc00' },
                    { name: '🔴 Červená (důležité)', value: '#ff0000' },
                    { name: '🟣 Fialová (události)', value: '#9932cc' }
                )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('setup-pozice')
        .setDescription('Nastaví systém výběru pozic (strojvůdce/výpravčí) - pouze pro adminy')
        .addChannelOption(option =>
            option.setName('kanál')
                .setDescription('Kanál kam poslat výběr pozic')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

// Registrace příkazů
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    
    try {
        console.log('Registruji slash příkazy globálně...');
        
        // Zkusíme globální registraci (trvá déle, ale méně problémů s oprávněními)
        await rest.put(
            Routes.applicationCommands("1418589810012196946"), // Bot ID
            { body: commands },
        );
        
        console.log('✅ Slash příkazy úspěšně registrovány globálně!');
        console.log('⏰ Může trvat až 1 hodinu, než se zobrazí všude.');
    } catch (error) {
        console.error('❌ Chyba při registraci příkazů:', error);
    }
}

client.on('ready', async () => {
    console.log(`Bot ${client.user.tag} je online!`);
    console.log('🚀 Verze s Google Sheets debug a !history příkazem - ' + new Date().toISOString());
    registerCommands(); // Registruj slash příkazy
    
    // Debug zpráva
    console.log('🔍 Zkouším inicializovat Google Sheets...');
    console.log('GOOGLE_CREDENTIALS existuje:', !!process.env.GOOGLE_CREDENTIALS);
    console.log('GOOGLE_SHEETS_ID existuje:', !!process.env.GOOGLE_SHEETS_ID);
    
    // Inicializuj Google Sheets
    await initializeGoogleSheets();
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // ===== PŘÍKAZ !HELP =====
    if (message.content === '!help' || message.content === '!pomoc') {
        const helpEmbed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('📋 MultiCargo Doprava - Seznam příkazů')
            .setDescription('🚂 Kompletní seznam dostupných příkazů')
            .addFields(
                {
                    name: '🚂 **Základní příkazy**',
                    value: '• `!jizda [číslo]` - začít jízdu vlakem\n• `!konec` - ukončit aktivní jízdu\n• `!stats` - vaše statistiky a body\n• `!top` - žebříček nejlepších řidičů\n• `!history` - historie vašich jízd',
                    inline: false
                },
                {
                    name: '🚉 **EDR příkazy** (pouze výpravčí)',
                    value: '• `!rozvrh [ID]` - rozvrh stanice\n• `!odjezdy [ID]` - nejbližších 5 odjezdů\n• `!prijezdy [ID]` - nejbližších 5 příjezdů\n• `!spoj [číslo]` - info o konkrétním vlaku\n• `!stanice` - seznam všech ID stanic\n• `!id` - nejpoužívanější stanice',
                    inline: false
                },
                {
                    name: '👥 **Systém pozic**',
                    value: '• Použijte tlačítka pro výběr pozice\n• 🚂 Strojvůdce - řízení vlaků\n• 🚉 Výpravčí - dispečerské funkce + EDR',
                    inline: false
                },
                {
                    name: '⚙️ **Admin příkazy**',
                    value: '• `!setup-aplikace` - nastavit systém přihlášek\n• `!setup-pozice` - nastavit výběr pozic\n• `!oznámení [text]` - poslat oznámení\n• `/schvalit` - schválit přihlášku\n• `/odmítnout` - odmítnout přihlášku',
                    inline: false
                },
                {
                    name: '🎯 **Bodový systém**',
                    value: '• **+10 bodů** za dokončenou jízdu\n• **+5 bonus** za dlouhé trasy (>50km)\n• **+3 bonus** za rychlé vlaky (>120 km/h)',
                    inline: false
                },
                {
                    name: '🔗 **Užitečné odkazy**',
                    value: '• [SimRail](https://simrail.eu/)\n• [Google Sheets](https://docs.google.com/spreadsheets/)\n• [GitHub Repo](https://github.com/)',
                    inline: false
                }
            )
            .setFooter({ text: 'MultiCargo Doprava • !help pro zobrazení nápovědy' })
            .setTimestamp();

        message.channel.send({ embeds: [helpEmbed] });
        return;
    }

    // ===== PŘÍKAZ PRO VYTVOŘENÍ EMBED PŘIHLÁŠKY (pouze pro adminy) =====
    if (message.content === '!setup-aplikace') {
        // Zkontroluj admin oprávnění
        if (!message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Nemáte oprávnění k nastavení systému přihlášek!');
            return;
        }

        const applicationEmbed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('🚂 Přihláška do týmu')
            .setDescription('**Chcete se stát součástí našeho SimRail týmu?**\n\nKlikněte na tlačítko níže a podejte svou přihlášku. Vytvoří se vám privátní kanál, kde můžete napsat důvod, proč se chcete připojit.')
            .addFields(
                { name: '📋 Co po přihlášení?', value: '• Získáte roli **👔 Zaměstnanec**\n• Přístup ke speciálním kanálům\n• Možnost řídit vlaky s týmem', inline: false },
                { name: '⏰ Jak dlouho to trvá?', value: 'Administrátoři posoudí vaši přihlášku obvykle do 24 hodin.', inline: false },
                { name: '💡 Tip', value: 'V přihlášce uveďte své zkušenosti se SimRail a proč se chcete připojit!', inline: false }
            )
            .setThumbnail(message.guild.iconURL())
            .setFooter({ text: 'Systém přihlášek • společnosti MultiCargoDoprava' })
            .setTimestamp();

        const button = new ButtonBuilder()
            .setCustomId('apply_button')
            .setLabel('📝 Podat přihlášku')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📋');

        const row = new ActionRowBuilder().addComponents(button);

        try {
            await message.channel.send({ embeds: [applicationEmbed], components: [row] });
            message.delete().catch(() => {}); // Smaž původní příkaz
        } catch (error) {
            console.error('Chyba při vytváření embed:', error);
            message.reply('❌ Došlo k chybě při vytváření systému přihlášek.');
        }
    }

    // ===== PŘÍKAZ !JIZDA (OPRAVENO - BEZ SPAMU) =====
    if (message.content.startsWith('!jizda')) {
        const args = message.content.slice('!jizda'.length).trim().split(' ');
        const vlakoveCislo = args[0];

        // Zkontroluj, jestli uživatel zadal číslo vlaku
        if (!vlakoveCislo || isNaN(vlakoveCislo)) {
            message.reply('Prosím, zadej platné číslo vlaku. Příklad: `!jizda 32922`');
            return;
        }

        // Zkontroluj, jestli už má aktivní jízdu
        if (aktivniJizdy.has(message.author.id)) {
            const aktivni = aktivniJizdy.get(message.author.id);
            message.reply(`⚠️ Už máte aktivní jízdu s vlakem **${aktivni.vlakCislo}**! Nejprve ji ukončete příkazem \`!konecjizdy ${aktivni.vlakCislo}\``);
            return;
        }

        try {
            // Získání dat z API - používáme český server který má vlaky
            const response = await axios.get('https://panel.simrail.eu:8084/trains-open?serverCode=cz1');
            console.log('API Response keys:', Object.keys(response.data));
            console.log('Počet vlaků:', response.data.count);
            
            // Správná struktura API - data jsou v response.data.data
            const vlaky = response.data.data;
            
            if (!Array.isArray(vlaky)) {
                console.log('API nevrátilo pole vlaků:', vlaky);
                message.reply('API momentálně nevrací data o vlacích. Zkus to prosím později.');
                return;
            }

            if (vlaky.length === 0) {
                message.reply('Momentálně nejsou na serveru žádné vlaky online. Zkus to prosím později.');
                return;
            }

            // Najdi vlak podle čísla - správné pole je TrainNoLocal
            const hledanyVlak = vlaky.find(vlak => 
                vlak.TrainNoLocal === vlakoveCislo || 
                vlak.TrainNoLocal === parseInt(vlakoveCislo) ||
                vlak.trainNo === parseInt(vlakoveCislo) ||
                vlak.TrainNo === parseInt(vlakoveCislo)
            );

            if (hledanyVlak) {
                // Spusť sledování jízdy
                const jizda = {
                    vlakCislo: hledanyVlak.TrainNoLocal,
                    startCas: Date.now(),
                    startStanice: hledanyVlak.StartStation,
                    cilStanice: hledanyVlak.EndStation,
                    trainName: hledanyVlak.TrainName || 'bez názvu'
                };
                
                aktivniJizdy.set(message.author.id, jizda);
                
                // Pošli zprávu do centrálního kanálu
                try {
                    const centralChannel = await client.channels.fetch(CONFIG.DISPATCHER_CHANNEL_ID);
                    await centralChannel.send(`✅ Jízda vlaku **${hledanyVlak.TrainNoLocal}** (${hledanyVlak.TrainName || 'bez názvu'}) byla zahájena!\n🚉 **${hledanyVlak.StartStation}** → **${hledanyVlak.EndStation}**\n👤 Strojvůdce: **${message.author.username}**`);
                } catch (error) {
                    console.error('Chyba při odesílání do centrálního kanálu:', error);
                    // Fallback do původního kanálu
                    message.reply(`✅ Jízda vlaku **${hledanyVlak.TrainNoLocal}** (${hledanyVlak.TrainName || 'bez názvu'}) byla zahájena!\n🚉 **${hledanyVlak.StartStation}** → **${hledanyVlak.EndStation}**`);
                }
            } else {
                // Ukažme uživateli prvních 5 dostupných vlaků
                const dostupneVlaky = vlaky.slice(0, 5).map(vlak => vlak.TrainNoLocal).join(', ');
                message.reply(`Vlak s číslem **${vlakoveCislo}** nebyl nalezen.\n\nDostupné vlaky (prvních 5): **${dostupneVlaky}**\n\nCelkem online vlaků: **${vlaky.length}**`);
            }

        } catch (error) {
            console.error('Došlo k chybě při volání API:', error);
            message.reply('Došlo k chybě při získávání dat o vlaku. Zkus to prosím později.');
        }
    }

    // ===== PŘÍKAZ !KONECJIZDY (OPRAVENO - BEZ SPAMU) =====
    if (message.content.startsWith('!konecjizdy') || message.content.startsWith('!konec')) {
        const args = message.content.split(' ');
        const vlakoveCislo = args[1];

        if (!vlakoveCislo) {
            message.reply('❌ Zadejte číslo vlaku. Použití: `!konecjizdy [číslo]`');
            return;
        }

        // Zkontroluj, jestli má aktivní jízdu
        if (!aktivniJizdy.has(message.author.id)) {
            message.reply('❌ Nemáte žádnou aktivní jízdu! Začněte jízdu příkazem `!jizda [číslo]`');
            return;
        }

        const aktivni = aktivniJizdy.get(message.author.id);

        // Zkontroluj, jestli číslo vlaku sedí
        if (aktivni.vlakCislo !== vlakoveCislo && aktivni.vlakCislo !== parseInt(vlakoveCislo)) {
            message.reply(`❌ Máte aktivní jízdu s vlakem **${aktivni.vlakCislo}**, ne s vlakem **${vlakoveCislo}**!`);
            return;
        }

        // Vypočítej délku jízdy
        const konecCas = Date.now();
        const dobaTrvani = Math.round((konecCas - aktivni.startCas) / (1000 * 60)); // v minutách
        
        if (dobaTrvani < 1) {
            message.reply('❌ Jízda musí trvat alespoň 1 minutu!');
            return;
        }

        // Získej user stats
        const stats = getUserStats(message.author.id);
        const dnes = new Date().toDateString();
        const isDenni = !stats.posledniJizda || new Date(stats.posledniJizda).toDateString() !== dnes;
        const isStreak = stats.posledniJizda && (Date.now() - new Date(stats.posledniJizda).getTime()) < 24 * 60 * 60 * 1000;

        // Vypočítej body
        const ziskaneBody = vypocitejBody(dobaTrvani, aktivni.trainName, isStreak, isDenni);

        // Aktualizuj streak
        if (isStreak) {
            stats.streak++;
        } else {
            stats.streak = 1;
        }

        // Aktualizuj statistiky
        stats.celkoveBody += ziskaneBody;
        stats.celkoveJizdy++;
        stats.celkovyCas += dobaTrvani;
        stats.posledniJizda = Date.now();
        
        const novaUroven = aktualizujUroven(message.author.id, stats.celkoveBody);

        // Ulož dokončenou jízdu
        if (!dokonceneJizdy.has(message.author.id)) {
            dokonceneJizdy.set(message.author.id, []);
        }
        
        const dokoncenaJizda = {
            vlakCislo: aktivni.vlakCislo,
            startCas: aktivni.startCas,
            konecCas: konecCas,
            doba: dobaTrvani,
            trasa: `${aktivni.startStanice} → ${aktivni.cilStanice}`,
            trainName: aktivni.trainName,
            body: ziskaneBody,
            datum: new Date().toLocaleDateString('cs-CZ')
        };
        
        dokonceneJizdy.get(message.author.id).push(dokoncenaJizda);

        // Zapiš jízdu do Google Sheets
        await zapisiJizduDoSheets(dokoncenaJizda, message.author.username);

        // Odstraň aktivní jízdu
        aktivniJizdy.delete(message.author.id);

        // Pošli zprávu do centrálního kanálu
        try {
            const centralChannel = await client.channels.fetch(CONFIG.DISPATCHER_CHANNEL_ID);
            await centralChannel.send(`🏁 Jízda vlaku **${aktivni.vlakCislo}** ukončena!\n👤 Strojvůdce: **${message.author.username}**\n⏰ Doba: **${dobaTrvani} minut**\n💰 Získané body: **${ziskaneBody}**\n🏆 Celkem: **${stats.celkoveBody} bodů** (${novaUroven})`);
        } catch (error) {
            console.error('Chyba při odesílání do centrálního kanálu:', error);
            // Fallback do původního kanálu
            message.reply(`🏁 Jízda vlaku **${aktivni.vlakCislo}** ukončena!\n⏰ Doba: **${dobaTrvani} minut**\n💰 Získané body: **${ziskaneBody}**\n🏆 Celkem: **${stats.celkoveBody} bodů** (${novaUroven})`);
        }
    }

    // ===== PŘÍKAZ !MOJEJIZDY =====
    if (message.content.startsWith('!mojejizdy') || message.content.startsWith('!moje')) {
        const stats = getUserStats(message.author.id);
        const jizdy = dokonceneJizdy.get(message.author.id) || [];
        
        // Hlavní stats embed
        const mainEmbed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle(`📊 Statistiky pro ${message.author.username}`)
            .addFields(
                { name: '🏆 Úroveň', value: aktualizujUroven(message.author.id, stats.celkoveBody), inline: true },
                { name: '💰 Celkové body', value: `${stats.celkoveBody}`, inline: true },
                { name: '🔥 Aktuální streak', value: `${stats.streak} jízd`, inline: true },
                { name: '🚂 Celkem jízd', value: `${stats.celkoveJizdy}`, inline: true },
                { name: '⏱️ Celkový čas', value: `${Math.round(stats.celkovyCas / 60)} hodin`, inline: true },
                { name: '📅 Poslední jízda', value: stats.posledniJizda ? new Date(stats.posledniJizda).toLocaleDateString('cs-CZ') : 'Nikdy', inline: true }
            )
            .setThumbnail(message.author.displayAvatarURL())
            .setTimestamp();

        if (stats.celkoveJizdy === 0) {
            mainEmbed.setDescription('Zatím jste nedokončili žádnou jízdu. Začněte příkazem `!jizda [číslo]`!');
            message.channel.send({ embeds: [mainEmbed] });
            return;
        }

        // Průměrné hodnoty
        const prumernyBody = Math.round(stats.celkoveBody / stats.celkoveJizdy);
        const prumernyCas = Math.round(stats.celkovyCas / stats.celkoveJizdy);
        
        mainEmbed.addFields(
            { name: '📈 Průměrně za jízdu', value: `${prumernyBody} bodů | ${prumernyCas} minut`, inline: false }
        );

        // Posledních 5 jízd
        if (jizdy.length > 0) {
            const poslednich5 = jizdy.slice(-5).reverse();
            let jizdiText = '';
            
            poslednich5.forEach((jizda, index) => {
                jizdiText += `**${jizda.vlakCislo}** • ${jizda.trasa} • ${jizda.doba}min • +${jizda.body} bodů\n`;
            });
            
            const jizdyEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('🚂 Posledních 5 jízd')
                .setDescription(jizdiText || 'Žádné jízdy')
                .setFooter({ text: `Zobrazeno ${Math.min(5, jizdy.length)} z ${jizdy.length} jízd` });
            
            message.channel.send({ embeds: [mainEmbed, jizdyEmbed] });
        } else {
            message.channel.send({ embeds: [mainEmbed] });
        }

        // Pokud má aktivní jízdu, ukaz ji
        if (aktivniJizdy.has(message.author.id)) {
            const aktivni = aktivniJizdy.get(message.author.id);
            const dobaTrvani = Math.round((Date.now() - aktivni.startCas) / (1000 * 60));
            
            const aktivniEmbed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle('🔄 Aktivní jízda')
                .setDescription(`Vlak **${aktivni.vlakCislo}** • ${aktivni.startStanice} → ${aktivni.cilStanice}`)
                .addFields(
                    { name: '⏰ Doba jízdy', value: `${dobaTrvani} minut`, inline: true },
                    { name: '💡 Tip', value: `Ukončete příkazem \`!konecjizdy ${aktivni.vlakCislo}\``, inline: false }
                );
            
            message.channel.send({ embeds: [aktivniEmbed] });
        }
    }

    // ===== PŘÍKAZ !ŽEBŘÍČEK =====
    if (message.content.startsWith('!žebříček') || message.content.startsWith('!zebricek') || message.content.startsWith('!leaderboard')) {
        // Seřaď uživatele podle bodů
        const sortedUsers = Array.from(userStats.entries())
            .filter(([userId, stats]) => stats.celkoveBody > 0)
            .sort((a, b) => b[1].celkoveBody - a[1].celkoveBody)
            .slice(0, 10); // Top 10

        if (sortedUsers.length === 0) {
            message.reply('🏆 Žebříček je zatím prázdný! Začněte jezdit a získávejte body pomocí `!jizda [číslo]`');
            return;
        }

        let leaderboardText = '';
        const medals = ['🥇', '🥈', '🥉'];
        
        for (let i = 0; i < sortedUsers.length; i++) {
            const [userId, stats] = sortedUsers[i];
            const user = await client.users.fetch(userId).catch(() => null);
            const userName = user ? user.username : 'Neznámý uživatel';
            const medal = i < 3 ? medals[i] : `${i + 1}.`;
            const uroven = aktualizujUroven(userId, stats.celkoveBody);
            
            leaderboardText += `${medal} **${userName}** • ${stats.celkoveBody} bodů • ${uroven} • ${stats.celkoveJizdy} jízd\n`;
        }

        const embed = new EmbedBuilder()
            .setColor('#ffd700')
            .setTitle('🏆 Žebříček strojvůdců')
            .setDescription(leaderboardText)
            .addFields(
                { 
                    name: '📊 Celkové statistiky', 
                    value: `**${sortedUsers.length}** aktivních strojvůdců\n**${sortedUsers.reduce((sum, [_, stats]) => sum + stats.celkoveJizdy, 0)}** dokončených jízd\n**${Math.round(sortedUsers.reduce((sum, [_, stats]) => sum + stats.celkovyCas, 0) / 60)}** hodin celkově`, 
                    inline: false 
                },
                {
                    name: '📋 Kompletní historie jízd',
                    value: `[📊 Zobrazit všechny jízdy v Google Sheets](https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_ID}/edit)`,
                    inline: false
                }
            )
            .setFooter({ text: 'Žebříček se aktualizuje v reálném čase' })
            .setTimestamp();

        message.channel.send({ embeds: [embed] });
    }

    // ===== PŘÍKAZ !HISTORY =====
    if (message.content.startsWith('!history') || message.content.startsWith('!historie')) {
        const historyEmbed = new EmbedBuilder()
            .setColor('#4285f4')
            .setTitle('📋 Historie všech jízd')
            .setDescription('Historie všech jízd ve firmě je zde:\nhttps://docs.google.com/spreadsheets/d/1aBf1rn1OeQrwLhw8NJgkfrE_xViTLqp6AYw2-HyPIRA/edit?usp=sharing')
            .addFields(
                {
                    name: '📊 Co najdete v tabulce:',
                    value: '• Datum a čas každé jízdy\n• Jméno strojvůdce\n• Číslo vlaku a trasu\n• Dobu trvání jízdy\n• Získané body',
                    inline: false
                },
                {
                    name: '💡 Tip:',
                    value: 'Tabulka se automaticky aktualizuje při každé dokončené jízdě!',
                    inline: false
                }
            )
            .setFooter({ text: 'MultiCargo Doprava • Tracking System' })
            .setTimestamp();

        message.channel.send({ embeds: [historyEmbed] });
    }

    // ===== EDR API PŘÍKAZY (pouze pro výpravčí) =====
    
    // ===== PŘÍKAZ !ROZVRH =====
    if (message.content.startsWith('!rozvrh')) {
        // Kontrola oprávnění - pouze výpravčí
        if (!message.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && !message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Tento příkaz může používat pouze role 🚉 **Výpravčí**!');
            return;
        }

        const args = message.content.slice('!rozvrh'.length).trim().split(' ');
        const stationId = args[0];

        if (!stationId || isNaN(stationId)) {
            message.reply('❌ Zadejte platné ID stanice. Příklad: `!rozvrh 3991`');
            return;
        }

        try {
            const response = await axios.get(`http://api1.aws.simrail.eu:8092/?serverCode=cz1&stationId=${stationId}&lang=cs`);
            
            // Jednoduchý parsing HTML tabulky (základní implementace)
            const htmlContent = response.data;
            
            const embed = new EmbedBuilder()
                .setColor('#4285f4')
                .setTitle(`🚉 Rozvrh stanice (ID: ${stationId})`)
                .setDescription('📋 Aktuální rozvrh pro vybranou stanici')
                .addFields(
                    {
                        name: '🔗 Podrobný rozvrh',
                        value: `[Zobrazit kompletní rozvrh](http://api1.aws.simrail.eu:8092/?serverCode=cz1&stationId=${stationId}&lang=cs)`,
                        inline: false
                    },
                    {
                        name: '💡 Tip',
                        value: 'Použijte `!odjezdy [ID_stanice]` pro nejbližší odjezdy',
                        inline: false
                    }
                )
                .setFooter({ text: 'MultiCargo Doprava • EDR System' })
                .setTimestamp();

            message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Chyba při načítání rozvrhu:', error);
            message.reply('❌ Došlo k chybě při načítání rozvrhu. Zkontrolujte ID stanice.');
        }
    }

    // ===== PŘÍKAZ !ODJEZDY =====
    if (message.content.startsWith('!odjezdy')) {
        // Kontrola oprávnění - pouze výpravčí
        if (!message.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && !message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Tento příkaz může používat pouze role 🚉 **Výpravčí**!');
            return;
        }

        const args = message.content.slice('!odjezdy'.length).trim().split(' ');
        const stationId = args[0];

        if (!stationId || isNaN(stationId)) {
            message.reply('❌ Zadejte platné ID stanice. Příklad: `!odjezdy 3991`');
            return;
        }

        try {
            const response = await axios.get(`http://api1.aws.simrail.eu:8092/?serverCode=cz1&stationId=${stationId}&lang=cs`);
            const htmlContent = response.data;
            
            // Parsování HTML pro odjezdy (hledáme tabulku s odjezdy)
            const odjezdyMatch = htmlContent.match(/<h3[^>]*>.*?Odjezdy.*?<\/h3>(.*?)<h3|<h3[^>]*>.*?Departures.*?<\/h3>(.*?)<h3/is);
            let odjezdyData = [];
            
            if (odjezdyMatch) {
                const tableContent = odjezdyMatch[1] || odjezdyMatch[2];
                // Parsování řádků tabulky
                const rows = tableContent.match(/<tr[^>]*>(.*?)<\/tr>/gis);
                
                if (rows) {
                    for (let i = 1; i < Math.min(6, rows.length); i++) { // První 5 odjezdů (přeskočit header)
                        const cells = rows[i].match(/<td[^>]*>(.*?)<\/td>/gis);
                        if (cells && cells.length >= 4) {
                            const cas = cells[0].replace(/<[^>]*>/g, '').trim();
                            const vlak = cells[1].replace(/<[^>]*>/g, '').trim();
                            const smer = cells[2].replace(/<[^>]*>/g, '').trim();
                            const kolej = cells[3].replace(/<[^>]*>/g, '').trim();
                            
                            if (cas && vlak) {
                                odjezdyData.push(`🕐 **${cas}** | 🚂 ${vlak} | 📍 ${smer}${kolej ? ` | 🛤️ ${kolej}` : ''}`);
                            }
                        }
                    }
                }
            }

            const embed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`⏰ Nejbližších 5 odjezdů (ID: ${stationId})`)
                .setDescription('🚂 Aktuální odjezdy z vybrané stanice')
                .setFooter({ text: 'MultiCargo Doprava • EDR System' })
                .setTimestamp();

            if (odjezdyData.length > 0) {
                embed.addFields({
                    name: '� Odjezdy vlaků',
                    value: odjezdyData.join('\n'),
                    inline: false
                });
            } else {
                embed.addFields({
                    name: '❌ Žádné odjezdy',
                    value: 'V tuto chvíli nejsou plánovány žádné odjezdy nebo došlo k chybě při parsování dat.',
                    inline: false
                });
            }

            embed.addFields({
                name: '🔗 Kompletní rozvrh',
                value: `[Zobrazit všechny odjezdy](http://api1.aws.simrail.eu:8092/?serverCode=cz1&stationId=${stationId}&lang=cs)`,
                inline: false
            });

            message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Chyba při načítání odjezdů:', error);
            message.reply('❌ Došlo k chybě při načítání odjezdů. Zkontrolujte ID stanice.');
        }
    }

    // ===== PŘÍKAZ !PRIJEZDY =====
    if (message.content.startsWith('!prijezdy')) {
        // Kontrola oprávnění - pouze výpravčí
        if (!message.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && !message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Tento příkaz může používat pouze role 🚉 **Výpravčí**!');
            return;
        }

        const args = message.content.slice('!prijezdy'.length).trim().split(' ');
        const stationId = args[0];

        if (!stationId || isNaN(stationId)) {
            message.reply('❌ Zadejte platné ID stanice. Příklad: `!prijezdy 3991`');
            return;
        }

        try {
            const response = await axios.get(`http://api1.aws.simrail.eu:8092/?serverCode=cz1&stationId=${stationId}&lang=cs`);
            const htmlContent = response.data;
            
            // Parsování HTML pro příjezdy
            const prijezdyMatch = htmlContent.match(/<h3[^>]*>.*?Příjezdy.*?<\/h3>(.*?)<h3|<h3[^>]*>.*?Arrivals.*?<\/h3>(.*?)<h3/is);
            let prijezdyData = [];
            
            if (prijezdyMatch) {
                const tableContent = prijezdyMatch[1] || prijezdyMatch[2];
                // Parsování řádků tabulky
                const rows = tableContent.match(/<tr[^>]*>(.*?)<\/tr>/gis);
                
                if (rows) {
                    for (let i = 1; i < Math.min(6, rows.length); i++) { // První 5 příjezdů (přeskočit header)
                        const cells = rows[i].match(/<td[^>]*>(.*?)<\/td>/gis);
                        if (cells && cells.length >= 4) {
                            const cas = cells[0].replace(/<[^>]*>/g, '').trim();
                            const vlak = cells[1].replace(/<[^>]*>/g, '').trim();
                            const odkud = cells[2].replace(/<[^>]*>/g, '').trim();
                            const kolej = cells[3].replace(/<[^>]*>/g, '').trim();
                            
                            if (cas && vlak) {
                                prijezdyData.push(`🕐 **${cas}** | 🚂 ${vlak} | 📍 ${odkud}${kolej ? ` | 🛤️ ${kolej}` : ''}`);
                            }
                        }
                    }
                }
            }

            const embed = new EmbedBuilder()
                .setColor('#e74c3c')
                .setTitle(`🚄 Nejbližších 5 příjezdů (ID: ${stationId})`)
                .setDescription('🚂 Aktuální příjezdy do vybrané stanice')
                .setFooter({ text: 'MultiCargo Doprava • EDR System' })
                .setTimestamp();

            if (prijezdyData.length > 0) {
                embed.addFields({
                    name: '🚄 Příjezdy vlaků',
                    value: prijezdyData.join('\n'),
                    inline: false
                });
            } else {
                embed.addFields({
                    name: '❌ Žádné příjezdy',
                    value: 'V tuto chvíli nejsou plánovány žádné příjezdy nebo došlo k chybě při parsování dat.',
                    inline: false
                });
            }

            embed.addFields({
                name: '🔗 Kompletní rozvrh',
                value: `[Zobrazit všechny příjezdy](http://api1.aws.simrail.eu:8092/?serverCode=cz1&stationId=${stationId}&lang=cs)`,
                inline: false
            });

            message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Chyba při načítání příjezdů:', error);
            message.reply('❌ Došlo k chybě při načítání příjezdů. Zkontrolujte ID stanice.');
        }
    }

    // ===== PŘÍKAZ !STANICE =====
    if (message.content.startsWith('!stanice')) {
        // Kontrola oprávnění - pouze výpravčí
        if (!message.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && !message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Tento příkaz může používat pouze role 🚉 **Výpravčí**!');
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle('🚉 Kompletní seznam ID stanic SimRail')
            .setDescription('📋 Všechna ID stanic pro použití s EDR příkazy (`!rozvrh`, `!odjezdy`)')
            .addFields(
                {
                    name: '�� **Hlavní trasa Warszawa - Kraków**',
                    value: '• `422` - Warszawa Wschodnia\n• `4500` - Warszawa Zachodnia\n• `5312` - Idzikowice\n• `5340` - Pilawa\n• `5100` - Radom\n• `5128` - Skarżysko-Kamienna\n• `5155` - Kielce\n• `4207` - Kozłów\n• `4230` - Busko-Zdrój\n• `4250` - Kraków Płaszów\n• `4288` - Kraków Główny',
                    inline: false
                },
                {
                    name: '🚂 **Śląska síť (Slezsko)**',
                    value: '• `3991` - Katowice Zawodzie\n• `3993` - Sosnowiec Główny\n• `4000` - Dąbrowa Górnicza Ząbkowice\n• `4020` - Będzin\n• `4040` - Katowice\n• `4060` - Chorzów Batory\n• `4080` - Bytom\n• `4100` - Zabrze\n• `4120` - Gliwice\n• `4140` - Ruda Śląska',
                    inline: false
                },
                {
                    name: '🌆 **Warszawa a okolí**',
                    value: '• `422` - Warszawa Wschodnia\n• `4500` - Warszawa Zachodnia\n• `4520` - Warszawa Centralna\n• `4540` - Warszawa Gdańska\n• `4560` - Legionowo\n• `4580` - Modlin\n• `4600` - Nasielsk\n• `4620` - Ciechanów',
                    inline: false
                },
                {
                    name: '🏔️ **Jižní Polsko**',
                    value: '• `4250` - Kraków Płaszów\n• `4288` - Kraków Główny\n• `4300` - Skawina\n• `4320` - Wadowice\n• `4340` - Kalwaria Zebrzydowska\n• `4360` - Andrychów\n• `4380` - Kęty\n• `4400` - Czechowice-Dziedzice',
                    inline: false
                },
                {
                    name: '� **Rychlé tratě (CMK)**',
                    value: '• `5200` - Grodzisk Mazowiecki\n• `5220` - Żyrardów\n• `5240` - Sochaczew\n• `5260` - Kutno\n• `5280` - Łowicz Główny\n• `5300` - Skierniewice\n• `5320` - Koluszki\n• `5340` - Piotrków Trybunalski',
                    inline: false
                },
                {
                    name: '⚡ **Užitečné tipy**',
                    value: '• `!rozvrh [ID]` - kompletní rozvrh stanice\n• `!odjezdy [ID]` - nejbližších 5 odjezdů\n• `!prijezdy [ID]` - nejbližších 5 příjezdů\n• `!spoj [číslo]` - info o konkrétním vlaku\n• Některé stanice mohou být dočasně nedostupné',
                    inline: false
                },
                {
                    name: '🔗 **Odkazy**',
                    value: '• [SimRail EDR](http://api1.aws.simrail.eu:8092/)\n• [SimRail Panel](https://panel.simrail.eu:8084/)\n• [Oficiální web](https://simrail.eu/)',
                    inline: false
                }
            )
            .setFooter({ text: 'MultiCargo Doprava • Aktualizováno 20.9.2025' })
            .setTimestamp();

        message.channel.send({ embeds: [embed] });
    }

    // ===== PŘÍKAZ !ID =====
    if (message.content.startsWith('!id')) {
        // Kontrola oprávnění - pouze výpravčí
        if (!message.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && !message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Tento příkaz může používat pouze role 🚉 **Výpravčí**!');
            return;
        }

        const quickEmbed = new EmbedBuilder()
            .setColor('#e74c3c')
            .setTitle('🚉 Nejpoužívanější ID stanic')
            .setDescription('⚡ Rychlý přehled nejdůležitějších stanic pro výpravčí')
            .addFields(
                {
                    name: '🏆 **TOP stanice**',
                    value: '• `422` - **Warszawa Wschodnia**\n• `4288` - **Kraków Główny**\n• `4250` - **Kraków Płaszów**\n• `3991` - **Katowice Zawodzie**\n• `3993` - **Sosnowiec Główny**',
                    inline: true
                },
                {
                    name: '🚂 **Hlavní uzly**',
                    value: '• `4500` - **Warszawa Zachodnia**\n• `5100` - **Radom**\n• `5155` - **Kielce**\n• `4040` - **Katowice**\n• `5300` - **Skierniewice**',
                    inline: true
                },
                {
                    name: '⚡ **Rychlé použití**',
                    value: '`!rozvrh 422` - rozvrh Warszawa Ws.\n`!odjezdy 4288` - odjezdy Kraków Gl.\n`!prijezdy 3991` - příjezdy Katowice\n`!stanice` - kompletní seznam',
                    inline: false
                }
            )
            .setFooter({ text: 'MultiCargo Doprava • Rychlý přehled' })
            .setTimestamp();

        message.channel.send({ embeds: [quickEmbed] });
    }

    // ===== PŘÍKAZ !SPOJ =====
    if (message.content.startsWith('!spoj')) {
        // Kontrola oprávnění - pouze výpravčí
        if (!message.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && !message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Tento příkaz může používat pouze role 🚉 **Výpravčí**!');
            return;
        }

        const args = message.content.slice('!spoj'.length).trim().split(' ');
        const trainNumber = args[0];

        if (!trainNumber || isNaN(trainNumber)) {
            message.reply('❌ Zadejte platné číslo vlaku. Příklad: `!spoj 5411`');
            return;
        }

        try {
            // Pokusíme se najít vlak v aktuální API
            const response = await axios.get('https://panel.simrail.eu:8084/trains-open?serverCode=cz1');
            const vlaky = response.data.data;
            
            const hledanyVlak = vlaky.find(vlak => 
                vlak.TrainNoLocal === trainNumber || 
                vlak.TrainNoLocal === parseInt(trainNumber)
            );

            const embed = new EmbedBuilder()
                .setColor('#9b59b6')
                .setTitle(`🚂 Informace o spoji ${trainNumber}`)
                .setFooter({ text: 'MultiCargo Doprava • EDR System' })
                .setTimestamp();

            if (hledanyVlak) {
                embed.setDescription(`✅ Spoj **${trainNumber}** byl nalezen v aktivních vlacích`)
                    .addFields(
                        {
                            name: '🚂 Základní info',
                            value: `**Číslo:** ${hledanyVlak.TrainNoLocal}\n**Název:** ${hledanyVlak.TrainName || 'Neznámý'}\n**Typ:** ${hledanyVlak.Vehicles || 'Neznámý'}`,
                            inline: true
                        },
                        {
                            name: '📍 Pozice',
                            value: `**Z:** ${hledanyVlak.StartStation || 'Neznámo'}\n**Do:** ${hledanyVlak.EndStation || 'Neznámo'}`,
                            inline: true
                        },
                        {
                            name: '🔗 EDR detaily',
                            value: `[Zobrazit v EDR](http://api1.aws.simrail.eu:8092/details?trainNumber=${trainNumber})`,
                            inline: false
                        }
                    );
            } else {
                embed.setDescription(`❌ Spoj **${trainNumber}** nebyl nalezen v aktivních vlacích`)
                    .addFields(
                        {
                            name: '🔍 Možná řešení',
                            value: '• Vlak momentálně nejede\n• Zkontrolujte číslo vlaku\n• Použijte `!rozvrh [ID_stanice]` pro rozvrh',
                            inline: false
                        },
                        {
                            name: '🔗 EDR detaily',
                            value: `[Zobrazit v EDR](http://api1.aws.simrail.eu:8092/details?trainNumber=${trainNumber})`,
                            inline: false
                        }
                    );
            }

            message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Chyba při hledání spoje:', error);
            message.reply('❌ Došlo k chybě při hledání spoje.');
        }
    }

    // ===== PŘÍKAZ !BODY =====
    if (message.content.startsWith('!body') || message.content.startsWith('!skore')) {
        const stats = getUserStats(message.author.id);
        const uroven = aktualizujUroven(message.author.id, stats.celkoveBody);
        
        // Vypočítej pokrok k další úrovni
        const nextLevelThreshold = UROVNE.find(level => level.min > stats.celkoveBody);
        
        let pokrokText = '';
        if (nextLevelThreshold) {
            const potrebne = nextLevelThreshold.min - stats.celkoveBody;
            pokrokText = `\n🎯 Do další úrovně (${nextLevelThreshold.nazev}): **${potrebne}** bodů`;
        } else {
            pokrokText = '\n👑 Máte nejvyšší úroveň!';
        }

        const embed = new EmbedBuilder()
            .setColor('#e74c3c')
            .setTitle(`💰 Body pro ${message.author.username}`)
            .setDescription(`**${stats.celkoveBody}** bodů • ${uroven}${pokrokText}`)
            .addFields(
                { name: '🔥 Streak', value: `${stats.streak} jízd`, inline: true },
                { name: '🚂 Celkem jízd', value: `${stats.celkoveJizdy}`, inline: true },
                { name: '⏱️ Celkový čas', value: `${Math.round(stats.celkovyCas / 60)}h`, inline: true }
            )
            .setThumbnail(message.author.displayAvatarURL())
            .setFooter({ text: 'Začněte jízdu příkazem !jizda [číslo]' });

        // Pokud má aktivní jízdu, přidej info
        if (aktivniJizdy.has(message.author.id)) {
            const aktivni = aktivniJizdy.get(message.author.id);
            const dobaTrvani = Math.round((Date.now() - aktivni.startCas) / (1000 * 60));
            embed.addFields({ 
                name: '🔄 Aktivní jízda', 
                value: `Vlak **${aktivni.vlakCislo}** (${dobaTrvani} min)`, 
                inline: false 
            });
        }

        message.channel.send({ embeds: [embed] });
    }

    // ===== ADMIN PŘÍKAZY PRO SCHVALOVÁNÍ V TICKET KANÁLECH =====
    if (message.content.startsWith('!schválit') || message.content.startsWith('!schvalit')) {
        // Zkontroluj admin oprávnění
        if (!message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Nemáte oprávnění k schvalování přihlášek!');
            return;
        }

        // Zkontroluj, jestli je to ticket kanál
        if (!message.channel.name.startsWith('přihláška-')) {
            message.reply('❌ Tento příkaz lze použít pouze v kanálech s přihláškami!');
            return;
        }

        // Najdi uživatele z aktivních přihlášek
        let targetUserId = null;
        let applicationData = null;
        
        for (const [userId, app] of activeApplications) {
            if (app.channelId === message.channel.id) {
                targetUserId = userId;
                applicationData = app;
                break;
            }
        }

        if (!targetUserId) {
            message.reply('❌ Nepodařilo se najít uživatele pro tuto přihlášku.');
            return;
        }

        try {
            const user = await client.users.fetch(targetUserId);
            const member = await message.guild.members.fetch(targetUserId);
            
            // Přidej roli zaměstnance
            await member.roles.add(CONFIG.EMPLOYEE_ROLE_ID);

            // Embed pro schválení
            const approvedEmbed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('✅ Přihláška schválena!')
                .setDescription(`**${user.tag}** byl úspěšně přijat do týmu!`)
                .addFields(
                    { name: '👨‍💼 Schválil', value: message.author.tag, inline: true },
                    { name: '📅 Datum', value: new Date().toLocaleString('cs-CZ'), inline: true },
                    { name: '🎭 Přidělená role', value: `<@&${CONFIG.EMPLOYEE_ROLE_ID}>`, inline: true }
                )
                .setTimestamp();

            await message.channel.send({ embeds: [approvedEmbed] });

            // Pošli DM uživateli
            try {
                const dmEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('🎉 Gratulujeme!')
                    .setDescription(`Vaše přihláška na serveru **${message.guild.name}** byla schválena!`)
                    .addFields(
                        { name: '✅ Co se stalo?', value: 'Byli jste přijati do týmu a získali jste roli **👔 Zaměstnanec**.' },
                        { name: '🚀 Co dál?', value: 'Můžete nyní využívat všechny funkce určené pro zaměstnance!' }
                    )
                    .setTimestamp();

                await user.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log('Nepodařilo se poslat DM uživateli:', dmError.message);
                message.channel.send(`⚠️ Uživatel byl schválen, ale nepodařilo se mu poslat DM.`);
            }

            // Odstraň z aktivních přihlášek
            activeApplications.delete(targetUserId);

            // Zavři kanál za 10 sekund
            setTimeout(() => {
                message.channel.delete().catch(console.error);
            }, 10000);

        } catch (error) {
            console.error('Chyba při schvalování:', error);
            message.reply('❌ Došlo k chybě při schvalování přihlášky. Zkontrolujte oprávnění bota.');
        }
    }

    if (message.content.startsWith('!zamítnout') || message.content.startsWith('!zamitnout')) {
        // Zkontroluj admin oprávnění
        if (!message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Nemáte oprávnění k zamítání přihlášek!');
            return;
        }

        // Zkontroluj, jestli je to ticket kanál
        if (!message.channel.name.startsWith('přihláška-')) {
            message.reply('❌ Tento příkaz lze použít pouze v kanálech s přihláškami!');
            return;
        }

        const reason = message.content.split(' ').slice(1).join(' ') || 'Bez udání důvodu';

        // Najdi uživatele z aktivních přihlášek
        let targetUserId = null;
        
        for (const [userId, app] of activeApplications) {
            if (app.channelId === message.channel.id) {
                targetUserId = userId;
                break;
            }
        }

        if (!targetUserId) {
            message.reply('❌ Nepodařilo se najít uživatele pro tuto přihlášku.');
            return;
        }

        try {
            const user = await client.users.fetch(targetUserId);

            // Embed pro zamítnutí
            const rejectedEmbed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('❌ Přihláška zamítnuta')
                .setDescription(`**${user.tag}** nebyl přijat do týmu.`)
                .addFields(
                    { name: '👨‍💼 Zamítl', value: message.author.tag, inline: true },
                    { name: '📅 Datum', value: new Date().toLocaleString('cs-CZ'), inline: true },
                    { name: '📝 Důvod', value: reason, inline: false }
                )
                .setTimestamp();

            await message.channel.send({ embeds: [rejectedEmbed] });

            // Pošli DM uživateli
            try {
                const dmEmbed = new EmbedBuilder()
                    .setColor('#ff0000')
                    .setTitle('📋 Rozhodnutí o přihlášce')
                    .setDescription(`Vaše přihláška na serveru **${message.guild.name}** byla zamítnuta.`)
                    .addFields(
                        { name: '📝 Důvod', value: reason },
                        { name: '🔄 Můžete zkusit znovu?', value: 'Ano, můžete podat novou přihlášku později.' }
                    )
                    .setTimestamp();

                await user.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log('Nepodařilo se poslat DM uživateli:', dmError.message);
            }

            // Odstraň z aktivních přihlášek
            activeApplications.delete(targetUserId);

            // Zavři kanál za 10 sekund
            setTimeout(() => {
                message.channel.delete().catch(console.error);
            }, 10000);

        } catch (error) {
            console.error('Chyba při zamítání:', error);
            message.reply('❌ Došlo k chybě při zamítání přihlášky.');
        }
    }
});

// ===== HANDLER PRO INTERAKCE S TLAČÍTKY A SLASH PŘÍKAZY =====
client.on('interactionCreate', async interaction => {
    // ===== SLASH PŘÍKAZY =====
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'oznámení') {
            // Zabráníme duplicitnímu zpracování
            await interaction.deferReply({ ephemeral: true });
            
            // Zkontroluj admin oprávnění
            if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.editReply({
                    content: '❌ Nemáte oprávnění k používání tohoto příkazu!'
                });
                return;
            }

            const targetChannel = interaction.options.getChannel('kanál');
            const announcementText = interaction.options.getString('text');
            const color = interaction.options.getString('barva') || '#0099ff';

            try {
                // Vytvoř hezký embed
                const announcementEmbed = new EmbedBuilder()
                    .setColor(color)
                    .setTitle('📢 Oznámení')
                    .setDescription(announcementText)
                    .addFields(
                        { name: '👨‍💼 Od', value: interaction.user.tag, inline: true },
                        { name: '📅 Datum', value: new Date().toLocaleString('cs-CZ'), inline: true }
                    )
                    .setThumbnail(interaction.guild.iconURL())
                    .setFooter({ text: `Poslal ${interaction.user.tag}` })
                    .setTimestamp();

                // Pošli do vybraného kanálu
                await targetChannel.send({ embeds: [announcementEmbed] });

                // Potvrzení adminovi
                await interaction.editReply({
                    content: `✅ Oznámení bylo úspěšně odesláno do kanálu ${targetChannel}!`
                });

            } catch (error) {
                console.error('Chyba při odesílání oznámení:', error);
                await interaction.editReply({
                    content: '❌ Došlo k chybě při odesílání oznámení. Zkontrolujte oprávnění bota v cílovém kanálu.'
                });
            }
        }

        if (interaction.commandName === 'setup-pozice') {
            await interaction.deferReply({ ephemeral: true });
            
            // Zkontroluj admin oprávnění
            if (!interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.editReply({
                    content: '❌ Nemáte oprávnění k používání tohoto příkazu!'
                });
                return;
            }

            const targetChannel = interaction.options.getChannel('kanál');

            try {
                const poziceEmbed = new EmbedBuilder()
                    .setColor('#4285f4')
                    .setTitle('🚂 Výběr pozice ve firmě')
                    .setDescription('**Vyberte si svou pozici v MultiCargo Doprava!**\n\nKlikněte na tlačítko níže pro výběr nebo odebrání pozice.')
                    .addFields(
                        { name: '🚂 Strojvůdce', value: 'Řídíte vlaky a zajišťujete přepravu nákladu', inline: true },
                        { name: '🚉 Výpravčí', value: 'Koordinujete provoz a dohlížíte na bezpečnost', inline: true },
                        { name: '💡 Poznámka', value: 'Můžete mít pouze jednu pozici současně. Kliknutím na stejné tlačítko pozici odeberete.', inline: false }
                    )
                    .setThumbnail(interaction.guild.iconURL())
                    .setFooter({ text: 'MultiCargo Doprava • Systém pozic' })
                    .setTimestamp();

                const strojvudceButton = new ButtonBuilder()
                    .setCustomId('pozice_strojvudce')
                    .setLabel('Strojvůdce')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🚂');

                const vypravciButton = new ButtonBuilder()
                    .setCustomId('pozice_vypravci')
                    .setLabel('Výpravčí')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🚉');

                const row = new ActionRowBuilder().addComponents(strojvudceButton, vypravciButton);

                await targetChannel.send({ embeds: [poziceEmbed], components: [row] });
                
                await interaction.editReply({
                    content: `✅ Systém výběru pozic byl úspěšně nastaven v kanálu ${targetChannel}!`
                });

            } catch (error) {
                console.error('Chyba při nastavování pozic:', error);
                await interaction.editReply({
                    content: '❌ Došlo k chybě při nastavování systému pozic. Zkontrolujte oprávnění bota.'
                });
            }
        }
    }

    // ===== TLAČÍTKA =====
    if (!interaction.isButton()) return;

    // Tlačítka pro výběr pozic
    if (interaction.customId === 'pozice_strojvudce' || interaction.customId === 'pozice_vypravci') {
        await interaction.deferReply({ ephemeral: true });

        const member = interaction.member;
        const isStrojvudce = interaction.customId === 'pozice_strojvudce';
        const targetRoleId = isStrojvudce ? CONFIG.STROJVUDCE_ROLE_ID : CONFIG.VYPRAVCI_ROLE_ID;
        const otherRoleId = isStrojvudce ? CONFIG.VYPRAVCI_ROLE_ID : CONFIG.STROJVUDCE_ROLE_ID;
        const poziceNazev = isStrojvudce ? '🚂 Strojvůdce' : '🚉 Výpravčí';
        const otherPoziceNazev = isStrojvudce ? '🚉 Výpravčí' : '🚂 Strojvůdce';

        try {
            // Zkontroluj, jestli uživatel už má tuto roli
            const hasTargetRole = member.roles.cache.has(targetRoleId);
            const hasOtherRole = member.roles.cache.has(otherRoleId);

            if (hasTargetRole) {
                // Odeber roli
                await member.roles.remove(targetRoleId);
                await interaction.editReply({
                    content: `✅ Pozice **${poziceNazev}** byla odebrána!`
                });
            } else {
                // Odeber druhou pozici, pokud ji má
                if (hasOtherRole) {
                    await member.roles.remove(otherRoleId);
                }
                
                // Přidej novou pozici
                await member.roles.add(targetRoleId);
                
                let message = `✅ Byla vám přidělena pozice **${poziceNazev}**!`;
                if (hasOtherRole) {
                    message += `\n(Pozice **${otherPoziceNazev}** byla automaticky odebrána)`;
                }
                
                await interaction.editReply({
                    content: message
                });
            }

        } catch (error) {
            console.error('Chyba při změně pozice:', error);
            await interaction.editReply({
                content: '❌ Došlo k chybě při změně pozice. Zkontrolujte oprávnění bota.'
            });
        }
    }

    // Tlačítko pro podání přihlášky
    if (interaction.customId === 'apply_button') {
        const userId = interaction.user.id;

        // Okamžitě odpověz, aby se zabránilo dvojitému kliknutí
        await interaction.deferReply({ ephemeral: true });

        // Zkontroluj, jestli už uživatel nemá aktivní přihlášku
        if (activeApplications.has(userId)) {
            await interaction.editReply({
                content: '⏳ Už máte aktivní přihlášku! Dokončete ji nebo požádejte administrátora o uzavření.'
            });
            return;
        }

        // Zkontroluj, jestli už existuje kanál s jeho jménem
        const existingChannel = interaction.guild.channels.cache.find(
            channel => channel.name === `přihláška-${interaction.user.username}`
        );
        
        if (existingChannel) {
            await interaction.editReply({
                content: `⚠️ Už máte aktivní přihlášku v kanálu ${existingChannel}!`
            });
            return;
        }

        // Zkontroluj, jestli už nemá roli zaměstnance
        const member = interaction.guild.members.cache.get(userId);
        if (member && member.roles.cache.has(CONFIG.EMPLOYEE_ROLE_ID)) {
            await interaction.editReply({
                content: '✅ Už jste členem týmu! Nemůžete podat další přihlášku.'
            });
            return;
        }

        // Dočasně přidej do mapy, aby se zabránilo dvojitému vytvoření
        activeApplications.set(userId, { processing: true });

        try {
            // Vytvoř privátní kanál (ticket)
            const ticketChannel = await interaction.guild.channels.create({
                name: `přihláška-${interaction.user.username}`,
                type: ChannelType.GuildText,
                parent: CONFIG.CATEGORY_ID, // Můžete nastavit správnou kategorii
                permissionOverwrites: [
                    {
                        id: interaction.guild.id, // @everyone
                        deny: [PermissionFlagsBits.ViewChannel],
                    },
                    {
                        id: userId, // Žadatel
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory
                        ],
                    },
                    {
                        id: CONFIG.ADMIN_ROLE_ID, // Admini
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.ManageMessages
                        ],
                    },
                ],
            });

            // Embed pro ticket kanál
            const ticketEmbed = new EmbedBuilder()
                .setColor('#ffcc00')
                .setTitle('📋 Vaše přihláška')
                .setDescription(`Ahoj ${interaction.user}! Vítejte v systému přihlášek.\n\n**Napište prosím svou přihlášku do tohoto kanálu:**\n• Proč se chcete připojit k našemu týmu?\n• Jaké máte zkušenosti se SimRail?\n• Jak často hrajete?`)
                .addFields(
                    { name: '⏰ Co se stane dál?', value: 'Administrátoři si vaši přihlášku přečtou a rozhodnou o přijetí.', inline: false },
                    { name: '🎯 Tipy pro úspěšnou přihlášku', value: '• Buďte upřímní a konkrétní\n• Popište své zkušenosti\n• Uveďte, jak můžete přispět týmu', inline: false }
                )
                .setFooter({ text: 'Pro schválení/zamítnutí použijte: !schválit nebo !zamítnout' })
                .setTimestamp();

            const closeButton = new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('🗑️ Zavřít přihlášku')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(closeButton);

            await ticketChannel.send({ 
                content: `${interaction.user} • <@&${CONFIG.ADMIN_ROLE_ID}>`,
                embeds: [ticketEmbed], 
                components: [row] 
            });

            // Ulož správné data přihlášky do mapy
            activeApplications.set(userId, {
                channelId: ticketChannel.id,
                user: interaction.user,
                timestamp: Date.now()
            });

            await interaction.editReply({
                content: `✅ Přihláška vytvořena! Pokračujte v kanálu ${ticketChannel}`
            });

        } catch (error) {
            console.error('Chyba při vytváření ticket kanálu:', error);
            // Odstraň z mapy pokud nastala chyba
            activeApplications.delete(userId);
            
            await interaction.editReply({
                content: '❌ Došlo k chybě při vytváření přihlášky. Kontaktujte administrátora.'
            });
        }
    }

    // Tlačítko pro zavření ticketu
    if (interaction.customId === 'close_ticket') {
        const channel = interaction.channel;
        
        // Zkontroluj oprávnění (admin nebo vlastník ticketu)
        const isAdmin = interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) || 
                       interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        const isOwner = channel.name.includes(interaction.user.username);

        if (!isAdmin && !isOwner) {
            await interaction.reply({
                content: '❌ Nemáte oprávnění k zavření této přihlášky!',
                ephemeral: true
            });
            return;
        }

        await interaction.reply('🗑️ Kanál bude uzavřen za 5 sekund...');
        
        setTimeout(() => {
            // Odstraň z mapy
            for (const [userId, app] of activeApplications) {
                if (app.channelId === channel.id) {
                    activeApplications.delete(userId);
                    break;
                }
            }
            
            channel.delete().catch(console.error);
        }, 5000);
    }
});

client.login(process.env.DISCORD_TOKEN);
