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
                    name: '🗺️ **API příkazy - informace o vlacích**',
                    value: '• `!vlak [číslo]` - kompletní info o vlaku\n• `!trasa [číslo]` - zobrazí celou trasu s časy\n• `!pozice [číslo]` - aktuální pozice vlaku\n• `!stanice-info [ID]` - detaily o stanici',
                    inline: false
                },
                {
                    name: ' **Systém pozic**',
                    value: '• Použijte tlačítka pro výběr pozice\n• 🚂 Strojvůdce - řízení vlaků\n• 🚉 Výpravčí - dispečerské funkce',
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
                    name: '💡 **Tipy**',
                    value: '• Používejte `!vlak [číslo]` před zahájením jízdy\n• `!pozice [číslo]` pro sledování pokroku\n• `!stanice-info 422` pro info o Warszawa Wschodnia',
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

    // ===== VELMI JEDNODUCHÝ TEST !test123 =====
    if (message.content === '!test123') {
        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('🔴 TEST - Bot je aktualizován!')
            .setDescription('Tento příkaz potvrzuje, že nový kód funguje')
            .addFields({
                name: '✅ Status',
                value: 'Bot má nejnovější verzi kódu',
                inline: false
            })
            .setFooter({ text: 'Test deployment • ' + new Date().toISOString() })
            .setTimestamp();
            
        message.channel.send({ embeds: [embed] });
        return;
    }

    // ===== JEDNODUCHÝ API TEST !apitest =====
    if (message.content === '!apitest') {
        try {
            const response = await axios.get(`https://api1.aws.simrail.eu:8082/api/getEDRTimetables?serverCode=cz1`);
            const trains = response.data;
            
            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('🟢 API TEST - JSON EDR funguje!')
                .setDescription('Test přímého volání JSON API')
                .addFields({
                    name: '📊 Výsledek',
                    value: `Získáno ${trains.length} vlaků z JSON API`,
                    inline: false
                })
                .setFooter({ text: 'API Test • ' + new Date().toISOString() })
                .setTimestamp();
                
            message.channel.send({ embeds: [embed] });
        } catch (error) {
            message.reply(`❌ API Test selhal: ${error.message}`);
        }
        return;
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
                    name: '⚡ **Informace pro výpravčí**',
                    value: 'EDR příkazy byly odstraněny.\nPro monitorování vlaků použijte `!jizda [číslo]`',
                    inline: false
                }
            )
            .setFooter({ text: 'MultiCargo Doprava • Rychlý přehled' })
            .setTimestamp();

        message.channel.send({ embeds: [quickEmbed] });
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

    // ===== PŘÍKAZ !VLAK [ČÍSLO] =====
    if (message.content.startsWith('!vlak')) {
        const args = message.content.slice('!vlak'.length).trim().split(' ');
        const vlakoveCislo = args[0];

        if (!vlakoveCislo || isNaN(vlakoveCislo)) {
            message.reply('❌ Prosím, zadejte platné číslo vlaku. Příklad: `!vlak 32922`');
            return;
        }

        try {
            const response = await axios.get('https://api1.aws.simrail.eu:8082/api/getAllTimetables?serverCode=cz1');
            const vlaky = response.data;

            if (!Array.isArray(vlaky) || vlaky.length === 0) {
                message.reply('❌ Momentálně nejsou dostupná data o vlacích. Zkuste to později.');
                return;
            }

            // Najdi vlak podle čísla
            const hledanyVlak = vlaky.find(vlak => 
                vlak.trainNoLocal === vlakoveCislo || 
                vlak.trainNoLocal === parseInt(vlakoveCislo)
            );

            if (!hledanyVlak) {
                message.reply(`❌ Vlak s číslem **${vlakoveCislo}** nebyl nalezen.\n💡 Tip: Použijte \`!jizda\` pro zobrazení dostupných vlaků.`);
                return;
            }

            // Informace o vlaku
            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle(`🚂 Vlak ${hledanyVlak.trainNoLocal}`)
                .setDescription(`**${hledanyVlak.trainName || 'Bez názvu'}**`)
                .addFields(
                    { name: '🚉 Výchozí stanice', value: hledanyVlak.startStation || 'Neznámá', inline: true },
                    { name: '🏁 Cílová stanice', value: hledanyVlak.endStation || 'Neznámá', inline: true },
                    { name: '🚂 Lokomotiva', value: hledanyVlak.locoType || 'Neznámá', inline: true },
                    { name: '⚖️ Váha', value: hledanyVlak.weight ? `${hledanyVlak.weight} t` : 'Neznámá', inline: true },
                    { name: '📏 Délka', value: hledanyVlak.length ? `${hledanyVlak.length} m` : 'Neznámá', inline: true },
                    { name: '🎯 Run ID', value: hledanyVlak.runId || 'Neznámé', inline: true }
                )
                .setFooter({ text: `Celkem zastávek: ${hledanyVlak.timetable ? hledanyVlak.timetable.length : 'Neznámo'} • Použijte !trasa ${vlakoveCislo} pro kompletní trasu` })
                .setTimestamp();

            // Přidej časy z první a poslední zastávky
            if (hledanyVlak.timetable && hledanyVlak.timetable.length > 0) {
                const prvniZastavka = hledanyVlak.timetable[0];
                const posledniZastavka = hledanyVlak.timetable[hledanyVlak.timetable.length - 1];
                
                embed.addFields(
                    { 
                        name: '⏰ Časový rozpis', 
                        value: `**Odjezd:** ${prvniZastavka.departureTime || 'N/A'}\n**Příjezd:** ${posledniZastavka.arrivalTime || 'N/A'}`, 
                        inline: false 
                    }
                );
            }

            message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Chyba při získávání informací o vlaku:', error);
            message.reply('❌ Došlo k chybě při získávání informací o vlaku. Zkuste to později.');
        }
    }

    // ===== PŘÍKAZ !TRASA [ČÍSLO] =====
    if (message.content.startsWith('!trasa')) {
        const args = message.content.slice('!trasa'.length).trim().split(' ');
        const vlakoveCislo = args[0];

        if (!vlakoveCislo || isNaN(vlakoveCislo)) {
            message.reply('❌ Prosím, zadejte platné číslo vlaku. Příklad: `!trasa 32922`');
            return;
        }

        try {
            const response = await axios.get('https://api1.aws.simrail.eu:8082/api/getAllTimetables?serverCode=cz1');
            const vlaky = response.data;

            if (!Array.isArray(vlaky) || vlaky.length === 0) {
                message.reply('❌ Momentálně nejsou dostupná data o vlacích. Zkuste to později.');
                return;
            }

            // Najdi vlak podle čísla
            const hledanyVlak = vlaky.find(vlak => 
                vlak.trainNoLocal === vlakoveCislo || 
                vlak.trainNoLocal === parseInt(vlakoveCislo)
            );

            if (!hledanyVlak) {
                message.reply(`❌ Vlak s číslem **${vlakoveCislo}** nebyl nalezen.\n💡 Tip: Použijte \`!vlak ${vlakoveCislo}\` pro základní info.`);
                return;
            }

            if (!hledanyVlak.timetable || hledanyVlak.timetable.length === 0) {
                message.reply(`❌ Pro vlak **${vlakoveCislo}** není dostupný časový rozpis.`);
                return;
            }

            // Hlavní embed s informacemi o vlaku
            const mainEmbed = new EmbedBuilder()
                .setColor('#9b59b6')
                .setTitle(`🗺️ Trasa vlaku ${hledanyVlak.trainNoLocal}`)
                .setDescription(`**${hledanyVlak.trainName || 'Bez názvu'}**\n${hledanyVlak.startStation} → ${hledanyVlak.endStation}`)
                .addFields(
                    { name: '🚂 Lokomotiva', value: hledanyVlak.locoType || 'Neznámá', inline: true },
                    { name: '📊 Zastávek celkem', value: `${hledanyVlak.timetable.length}`, inline: true },
                    { name: '🎯 Run ID', value: hledanyVlak.runId || 'Neznámé', inline: true }
                );

            // Vytvoř seznam zastávek - omez na prvních 20 kvůli délce
            const maxStops = 20;
            const stops = hledanyVlak.timetable.slice(0, maxStops);
            let trasaText = '';

            stops.forEach((stop, index) => {
                const emoji = index === 0 ? '🚉' : index === stops.length - 1 && index < hledanyVlak.timetable.length - 1 ? '⭐' : index === hledanyVlak.timetable.length - 1 ? '🏁' : '▫️';
                const arrTime = stop.arrivalTime || '--:--';
                const depTime = stop.departureTime || '--:--';
                const platform = stop.platform ? ` | ${stop.platform}` : '';
                const track = stop.track ? ` | ${stop.track}` : '';
                
                if (index === 0) {
                    trasaText += `${emoji} **${stop.nameOfPoint}** | Odjezd: **${depTime}**${platform}${track}\n`;
                } else if (index === hledanyVlak.timetable.length - 1) {
                    trasaText += `${emoji} **${stop.nameOfPoint}** | Příjezd: **${arrTime}**${platform}${track}\n`;
                } else {
                    if (arrTime === depTime) {
                        trasaText += `${emoji} ${stop.nameOfPoint} | **${arrTime}**${platform}${track}\n`;
                    } else {
                        trasaText += `${emoji} ${stop.nameOfPoint} | ${arrTime} - ${depTime}${platform}${track}\n`;
                    }
                }
            });

            if (hledanyVlak.timetable.length > maxStops) {
                trasaText += `\n... a ${hledanyVlak.timetable.length - maxStops} dalších zastávek`;
            }

            const routeEmbed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🚉 Časový rozpis')
                .setDescription(trasaText)
                .setFooter({ text: `${stops.length}/${hledanyVlak.timetable.length} zastávek • Použijte !pozice ${vlakoveCislo} pro aktuální pozici` });

            message.channel.send({ embeds: [mainEmbed, routeEmbed] });

        } catch (error) {
            console.error('Chyba při získávání trasy vlaku:', error);
            message.reply('❌ Došlo k chybě při získávání trasy vlaku. Zkuste to později.');
        }
    }

    // ===== PŘÍKAZ !POZICE [ČÍSLO] =====
    if (message.content.startsWith('!pozice')) {
        const args = message.content.slice('!pozice'.length).trim().split(' ');
        const vlakoveCislo = args[0];

        if (!vlakoveCislo || isNaN(vlakoveCislo)) {
            message.reply('❌ Prosím, zadejte platné číslo vlaku. Příklad: `!pozice 32922`');
            return;
        }

        try {
            const response = await axios.get('https://api1.aws.simrail.eu:8082/api/getAllTimetables?serverCode=cz1');
            const vlaky = response.data;

            if (!Array.isArray(vlaky) || vlaky.length === 0) {
                message.reply('❌ Momentálně nejsou dostupná data o vlacích. Zkuste to později.');
                return;
            }

            // Najdi vlak podle čísla
            const hledanyVlak = vlaky.find(vlak => 
                vlak.trainNoLocal === vlakoveCislo || 
                vlak.trainNoLocal === parseInt(vlakoveCislo)
            );

            if (!hledanyVlak) {
                message.reply(`❌ Vlak s číslem **${vlakoveCislo}** nebyl nalezen.`);
                return;
            }

            if (!hledanyVlak.timetable || hledanyVlak.timetable.length === 0) {
                message.reply(`❌ Pro vlak **${vlakoveCislo}** není dostupný časový rozpis.`);
                return;
            }

            // Získej aktuální čas v UTC (SimRail používá UTC časy)
            const now = new Date();
            const currentTime = now.toISOString().substring(11, 16); // HH:MM format

            // Funkce pro převod času na minuty
            function timeToMinutes(timeStr) {
                if (!timeStr || timeStr === '--:--') return -1;
                const [hours, minutes] = timeStr.split(':').map(Number);
                return hours * 60 + minutes;
            }

            const currentMinutes = timeToMinutes(currentTime);
            let currentPosition = null;
            let nextStation = null;
            let previousStation = null;

            // Najdi aktuální pozici na trase
            for (let i = 0; i < hledanyVlak.timetable.length; i++) {
                const stop = hledanyVlak.timetable[i];
                const arrTime = timeToMinutes(stop.arrivalTime);
                const depTime = timeToMinutes(stop.departureTime);

                if (i === 0) {
                    // První zastávka - pouze odjezd
                    if (currentMinutes < timeToMinutes(stop.departureTime)) {
                        currentPosition = { type: 'waiting', station: stop, index: i };
                        break;
                    }
                } else if (i === hledanyVlak.timetable.length - 1) {
                    // Poslední zastávka - pouze příjezd
                    if (currentMinutes >= arrTime) {
                        currentPosition = { type: 'arrived', station: stop, index: i };
                        break;
                    }
                } else {
                    // Mezilehlé zastávky
                    if (currentMinutes >= arrTime && currentMinutes <= depTime) {
                        currentPosition = { type: 'at_station', station: stop, index: i };
                        break;
                    }
                }

                // Vlak mezi zastávkami
                if (i < hledanyVlak.timetable.length - 1) {
                    const nextStop = hledanyVlak.timetable[i + 1];
                    const currentDepTime = depTime !== -1 ? depTime : arrTime;
                    const nextArrTime = timeToMinutes(nextStop.arrivalTime);

                    if (currentMinutes > currentDepTime && currentMinutes < nextArrTime) {
                        currentPosition = { 
                            type: 'between', 
                            from: stop, 
                            to: nextStop, 
                            index: i 
                        };
                        break;
                    }
                }
            }

            if (!currentPosition) {
                // Vlak ještě nezačal nebo už skončil
                const firstDep = timeToMinutes(hledanyVlak.timetable[0].departureTime);
                const lastArr = timeToMinutes(hledanyVlak.timetable[hledanyVlak.timetable.length - 1].arrivalTime);
                
                if (currentMinutes < firstDep) {
                    currentPosition = { type: 'not_started', station: hledanyVlak.timetable[0] };
                } else if (currentMinutes > lastArr) {
                    currentPosition = { type: 'finished', station: hledanyVlak.timetable[hledanyVlak.timetable.length - 1] };
                }
            }

            // Vytvoř embed s pozicí
            const embed = new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`📍 Pozice vlaku ${hledanyVlak.trainNoLocal}`)
                .setDescription(`**${hledanyVlak.trainName || 'Bez názvu'}**`)
                .addFields({ name: '🕐 Aktuální čas', value: currentTime, inline: true });

            let statusText = '';
            let statusColor = '#f39c12';

            switch (currentPosition?.type) {
                case 'not_started':
                    statusText = `🔴 **Vlak ještě nevyjel**\nOdjezd z **${currentPosition.station.nameOfPoint}** v **${currentPosition.station.departureTime}**`;
                    statusColor = '#e74c3c';
                    break;
                case 'waiting':
                    statusText = `🟡 **Připraven k odjezdu**\nStanice: **${currentPosition.station.nameOfPoint}**\nOdjezd: **${currentPosition.station.departureTime}**`;
                    statusColor = '#f1c40f';
                    break;
                case 'at_station':
                    statusText = `🟢 **Stojí ve stanici**\n**${currentPosition.station.nameOfPoint}**\nOdjezd: **${currentPosition.station.departureTime}**`;
                    if (currentPosition.station.platform) statusText += `\nNástup.: **${currentPosition.station.platform}**`;
                    statusColor = '#27ae60';
                    break;
                case 'between':
                    statusText = `🚂 **Jede mezi stanicemi**\n**${currentPosition.from.nameOfPoint}** → **${currentPosition.to.nameOfPoint}**\nPříjezd: **${currentPosition.to.arrivalTime}**`;
                    statusColor = '#3498db';
                    break;
                case 'arrived':
                    statusText = `🏁 **Vlak dorazil do cíle**\n**${currentPosition.station.nameOfPoint}**\nPříjezd: **${currentPosition.station.arrivalTime}**`;
                    statusColor = '#9b59b6';
                    break;
                case 'finished':
                    statusText = `⚫ **Vlak ukončil jízdu**\nCílová stanice: **${currentPosition.station.nameOfPoint}**`;
                    statusColor = '#95a5a6';
                    break;
                default:
                    statusText = '❓ **Nelze určit pozici**\nData o pozici nejsou k dispozici';
                    statusColor = '#e74c3c';
            }

            embed.setColor(statusColor);
            embed.addFields({ name: '📍 Aktuální stav', value: statusText, inline: false });

            // Přidej další/předchozí zastávky pokud jsou relevantní
            if (currentPosition && currentPosition.index !== undefined) {
                const nextStops = hledanyVlak.timetable.slice(currentPosition.index + 1, currentPosition.index + 4);
                if (nextStops.length > 0) {
                    let nextText = nextStops.map(stop => 
                        `• **${stop.nameOfPoint}** - ${stop.arrivalTime || stop.departureTime}`
                    ).join('\n');
                    embed.addFields({ name: '⏭️ Následující zastávky', value: nextText, inline: false });
                }
            }

            embed.setFooter({ text: `Použijte !trasa ${vlakoveCislo} pro kompletní trasu` });
            embed.setTimestamp();

            message.channel.send({ embeds: [embed] });

        } catch (error) {
            console.error('Chyba při získávání pozice vlaku:', error);
            message.reply('❌ Došlo k chybě při získávání pozice vlaku. Zkuste to později.');
        }
    }

    // ===== PŘÍKAZ !STANICE-INFO [ID] =====
    if (message.content.startsWith('!stanice-info') || message.content.startsWith('!stanice')) {
        const args = message.content.split(' ')[1];
        const stationId = args;

        if (!stationId) {
            message.reply('❌ Prosím, zadejte ID stanice. Příklad: `!stanice-info 422`\n💡 Nejpoužívanější: 422 (Warszawa Wschodnia), 4288 (Kraków Główny), 4250 (Kraków Płaszów)');
            return;
        }

        try {
            const response = await axios.get('https://api1.aws.simrail.eu:8082/api/getAllTimetables?serverCode=cz1');
            const vlaky = response.data;

            if (!Array.isArray(vlaky) || vlaky.length === 0) {
                message.reply('❌ Momentálně nejsou dostupná data o vlacích. Zkuste to později.');
                return;
            }

            // Najdi všechny vlaky, které projíždějí touto stanicí
            const vlakyVeStanici = [];
            let stationName = null;

            vlaky.forEach(vlak => {
                if (vlak.timetable && Array.isArray(vlak.timetable)) {
                    vlak.timetable.forEach(stop => {
                        if (stop.pointId === stationId || stop.pointId === parseInt(stationId)) {
                            if (!stationName) stationName = stop.nameOfPoint;
                            vlakyVeStanici.push({
                                trainNo: vlak.trainNoLocal,
                                trainName: vlak.trainName,
                                arrivalTime: stop.arrivalTime,
                                departureTime: stop.departureTime,
                                platform: stop.platform,
                                track: stop.track,
                                stopType: stop.stopType,
                                startStation: vlak.startStation,
                                endStation: vlak.endStation,
                                locoType: vlak.locoType
                            });
                        }
                    });
                }
            });

            if (vlakyVeStanici.length === 0) {
                message.reply(`❌ Stanice s ID **${stationId}** nebyla nalezena nebo jí neprojíždí žádné vlaky.\n💡 Zkuste jiné ID nebo použijte \`!id\` pro seznam nejpoužívanějších stanic.`);
                return;
            }

            // Seřaď vlaky podle času
            vlakyVeStanici.sort((a, b) => {
                const timeA = a.arrivalTime || a.departureTime || '00:00';
                const timeB = b.arrivalTime || b.departureTime || '00:00';
                return timeA.localeCompare(timeB);
            });

            // Hlavní embed
            const mainEmbed = new EmbedBuilder()
                .setColor('#e67e22')
                .setTitle(`🚉 ${stationName || 'Neznámá stanice'}`)
                .setDescription(`**ID stanice:** ${stationId}`)
                .addFields(
                    { name: '🚂 Celkem vlaků', value: `${vlakyVeStanici.length}`, inline: true },
                    { name: '📊 Údaje k dispozici', value: 'Časy, nástupiště, koleje', inline: true },
                    { name: '🔄 Aktualizace', value: 'V reálném čase', inline: true }
                );

            // Seznam vlaků - omez na prvních 15
            const maxTrains = 15;
            const displayTrains = vlakyVeStanici.slice(0, maxTrains);
            let vlakText = '';

            displayTrains.forEach(vlak => {
                const timeInfo = vlak.arrivalTime && vlak.departureTime && vlak.arrivalTime !== vlak.departureTime 
                    ? `${vlak.arrivalTime} - ${vlak.departureTime}`
                    : vlak.arrivalTime || vlak.departureTime || '--:--';
                
                const platformInfo = vlak.platform ? ` | ${vlak.platform}` : '';
                const trackInfo = vlak.track ? ` | ${vlak.track}` : '';
                
                vlakText += `🚂 **${vlak.trainNo}** (${vlak.trainName || 'bez názvu'})\n`;
                vlakText += `⏰ ${timeInfo}${platformInfo}${trackInfo}\n`;
                vlakText += `📍 ${vlak.startStation} → ${vlak.endStation}\n\n`;
            });

            if (vlakyVeStanici.length > maxTrains) {
                vlakText += `... a ${vlakyVeStanici.length - maxTrains} dalších vlaků`;
            }

            const trainsEmbed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle('🚂 Projíždějící vlaky')
                .setDescription(vlakText || 'Žádné vlaky nenalezeny')
                .setFooter({ text: `${displayTrains.length}/${vlakyVeStanici.length} vlaků • Seřazeno podle času` });

            // Statistiky
            const osobniVlaky = vlakyVeStanici.filter(v => !v.locoType || v.locoType.includes('EN') || v.trainName?.includes('IC') || v.trainName?.includes('EC')).length;
            const nakladniVlaky = vlakyVeStanici.filter(v => v.locoType && (v.locoType.includes('ET22') || v.locoType.includes('SM42'))).length;

            const statsEmbed = new EmbedBuilder()
                .setColor('#27ae60')
                .setTitle('📊 Statistiky stanice')
                .addFields(
                    { name: '👥 Osobní doprava', value: `${osobniVlaky} vlaků`, inline: true },
                    { name: '📦 Nákladní doprava', value: `${nakladniVlaky} vlaků`, inline: true },
                    { name: '🎯 Využití', value: vlakyVeStanici.length > 20 ? 'Vysoké' : vlakyVeStanici.length > 10 ? 'Střední' : 'Nízké', inline: true }
                )
                .setFooter({ text: 'Použijte !vlak [číslo] pro detail konkrétního vlaku' });

            message.channel.send({ embeds: [mainEmbed, trainsEmbed, statsEmbed] });

        } catch (error) {
            console.error('Chyba při získávání informací o stanici:', error);
            message.reply('❌ Došlo k chybě při získávání informací o stanici. Zkuste to později.');
        }
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
