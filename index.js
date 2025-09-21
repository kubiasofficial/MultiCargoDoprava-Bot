const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, SlashCommandBuilder, REST, Routes, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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
    ACTIVE_RIDES_CHANNEL_ID: '1419230177585528842', // Kanál pro live tracking aktivních jízd
    
    // Role pozic (budete muset přidat skutečné ID rolí)
    STROJVUDCE_ROLE_ID: '1418875308811223123', // 🚂 Strojvůdce
    VYPRAVCI_ROLE_ID: '1418875376855158825', // 🚉 Výpravčí
    
    // Systém zakázek
    ZAKAZKY_SETUP_CHANNEL_ID: '1418966879330111508', // Kanál kde se vytvoří embed pro zakázky
    ZAKAZKY_CATEGORY_ID: '1418968983629074574', // Kategorie pro zakázkové kanály
    ZAKAZKY_LOG_CATEGORY_ID: '1418969133936279623' // Kategorie pro log dokončených zakázek
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

// Úložiště pro aktivní zakázky
const activeZakazky = new Map(); // zakazkaId -> { channelId, vypravci, assignedUser, vlakCislo, created }

// ===== DATABÁZE PRO SLEDOVÁNÍ JÍZD =====
const aktivniJizdy = new Map(); // userId -> { vlakCislo, startCas, startStanice, cilStanice, trainName, trackingMessageId, trackingChannelId }
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
    
    // ===== SPUŠTĚNÍ AUTOMATICKÝCH AKTUALIZACÍ LIVE TRACKING =====
    console.log('🔄 Spouštím automatické aktualizace live tracking...');
    setInterval(async () => {
        try {
            for (const [userId, jizda] of aktivniJizdy) {
                if (jizda.trackingMessageId && jizda.trackingChannelId) {
                    // Vypočítej aktuální dobu jízdy
                    const currentDuration = Math.round((Date.now() - jizda.startCas) / (1000 * 60)); // v minutách
                    const estimatedDuration = jizda.estimatedDuration || 60;
                    
                    // Aktualizuj progress bar
                    const progressBar = createProgressBar(currentDuration, estimatedDuration);
                    
                    // Vytvoř aktualizovaný embed
                    const updatedEmbed = new EmbedBuilder()
                        .setColor('#ffff00')
                        .setTitle(`🚂 Jízda vlaku ${jizda.vlakCislo}`)
                        .setDescription(progressBar)
                        .addFields(
                            { name: '🚉 Trasa', value: `${jizda.startStanice} ──────●────── ${jizda.cilStanice}`, inline: false },
                            { name: '⏱️ Doba jízdy', value: `${currentDuration}/${estimatedDuration} minut`, inline: true },
                            { name: '📍 Aktuálně', value: jizda.startStanice, inline: true },
                            { name: '👤 Strojvůdce', value: `<@${userId}>`, inline: true }
                        )
                        .setThumbnail(client.users.cache.get(userId)?.displayAvatarURL() || null)
                        .setFooter({ text: `${jizda.trainName} • Live tracking` })
                        .setTimestamp();

                    // Aktualizuj embed
                    try {
                        const channel = await client.channels.fetch(jizda.trackingChannelId);
                        const message = await channel.messages.fetch(jizda.trackingMessageId);
                        await message.edit({ embeds: [updatedEmbed] });
                        console.log(`🔄 Aktualizován live tracking pro vlak ${jizda.vlakCislo}`);
                    } catch (error) {
                        console.error(`❌ Chyba při aktualizaci live tracking pro ${jizda.vlakCislo}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error('❌ Chyba v automatických aktualizacích:', error);
        }
    }, 5 * 60 * 1000); // 5 minut v milisekundách
});

// ===== FUNKCE PRO PROGRESS BAR A LIVE TRACKING =====
function createProgressBar(current, total) {
    const percent = Math.round((current / total) * 100);
    const filled = Math.round(percent / 6.25); // 16 symbolů max
    const empty = 16 - filled;
    return '━'.repeat(filled) + '░'.repeat(empty) + ` ${percent}%`;
}

// Předpokládaná doba jízdy (pro progress bar) - můžeme rozšířit na skutečná data z API
function getEstimatedDuration(startStation, endStation) {
    // Základní odhady - později můžeme nahradit skutečnými daty z SimRail API
    const distances = {
        'Praha': { 'Brno': 90, 'Ostrava': 180, 'Bratislava': 120 },
        'Brno': { 'Praha': 90, 'Ostrava': 120, 'Bratislava': 90 },
        'Ostrava': { 'Praha': 180, 'Brno': 120, 'Bratislava': 150 },
        'Bratislava': { 'Praha': 120, 'Brno': 90, 'Ostrava': 150 }
    };
    
    // Zkusíme najít odhad, jinak použijeme default 60 minut
    if (distances[startStation] && distances[startStation][endStation]) {
        return distances[startStation][endStation];
    }
    return 60; // default 60 minut
}

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
                    value: '• `!vlak [číslo]` - kompletní info o vlaku\n• `!trasa [číslo]` - zobrazí celou trasu s časy\n• `!pozice [číslo]` - aktuální pozice vlaku\n• `!stanice-info [ID]` - detaily o stanici\n• `!stanice-seznam` - seznam všech stanic',
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

    // ===== PŘÍKAZ PRO VYTVOŘENÍ SYSTÉMU ZAKÁZEK (pouze pro adminy) =====
    if (message.content === '!setup-zakazky') {
        // Zkontroluj oprávnění výpravčí nebo admin
        if (!message.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && 
            !message.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && 
            !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            message.reply('❌ Nemáte oprávnění k nastavení systému zakázek! Tento příkaz mohou používat pouze výpravčí.');
            return;
        }

        const zakazkyEmbed = new EmbedBuilder()
            .setColor('#e67e22')
            .setTitle('📋 Systém přidělování zakázek')
            .setDescription('**Výpravčí mohou přidělovat zakázky strojvůdcům**\n\nKlikněte na tlačítko níže pro vytvoření nové zakázky. Vyplníte komu zakázku přidělujete a číslo vlaku.')
            .addFields(
                { name: '👨‍💼 Kdo může přidělovat?', value: '• Pouze role **🚉 Výpravčí**\n• Vedení a administrátoři', inline: false },
                { name: '📋 Jak to funguje?', value: '• Kliknete na "Vytvořit zakázku"\n• Vyplníte Discord ID uživatele\n• Zadáte číslo vlaku\n• Vytvoří se privátní kanál', inline: false },
                { name: '🎯 Co se stane?', value: '• Uživatel dostane DM notifikaci\n• Otevře se mu zakázkový kanál\n• Po dokončení se kanál archivuje', inline: false }
            )
            .setThumbnail(message.guild.iconURL())
            .setFooter({ text: 'MultiCargo Doprava • Systém zakázek' })
            .setTimestamp();

        const createButton = new ButtonBuilder()
            .setCustomId('create_zakazka')
            .setLabel('📝 Vytvořit zakázku')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🚂');

        const row = new ActionRowBuilder().addComponents(createButton);

        try {
            await message.channel.send({ embeds: [zakazkyEmbed], components: [row] });
            message.delete().catch(() => {}); // Smaž původní příkaz
        } catch (error) {
            console.error('Chyba při vytváření systému zakázek:', error);
            message.reply('❌ Došlo k chybě při vytváření systému zakázek.');
        }
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
                // Spusť sledování jízdy - nejdříve vytvoř live tracking embed
                const estimatedDuration = getEstimatedDuration(hledanyVlak.StartStation, hledanyVlak.EndStation);
                
                // Vytvoř live tracking embed
                const liveEmbed = new EmbedBuilder()
                    .setColor('#ffff00')
                    .setTitle(`🚂 Jízda vlaku ${hledanyVlak.TrainNoLocal}`)
                    .setDescription(createProgressBar(0, estimatedDuration))
                    .addFields(
                        { name: '🚉 Trasa', value: `${hledanyVlak.StartStation} ──────●────── ${hledanyVlak.EndStation}`, inline: false },
                        { name: '⏱️ Doba jízdy', value: `0/${estimatedDuration} minut`, inline: true },
                        { name: '📍 Aktuálně', value: hledanyVlak.StartStation, inline: true },
                        { name: '👤 Strojvůdce', value: message.author.toString(), inline: true }
                    )
                    .setThumbnail(message.author.displayAvatarURL())
                    .setFooter({ text: `${hledanyVlak.TrainName || 'bez názvu'} • Live tracking` })
                    .setTimestamp();

                // Pošli live embed do kanálu aktivních jízd
                let trackingMessage = null;
                try {
                    const activeRidesChannel = await client.channels.fetch(CONFIG.ACTIVE_RIDES_CHANNEL_ID);
                    trackingMessage = await activeRidesChannel.send({ embeds: [liveEmbed] });
                } catch (error) {
                    console.error('Chyba při vytváření live tracking embedu:', error);
                }

                // Spusť sledování jízdy s live tracking daty
                const jizda = {
                    vlakCislo: hledanyVlak.TrainNoLocal,
                    startCas: Date.now(),
                    startStanice: hledanyVlak.StartStation,
                    cilStanice: hledanyVlak.EndStation,
                    trainName: hledanyVlak.TrainName || 'bez názvu',
                    estimatedDuration: estimatedDuration,
                    trackingMessageId: trackingMessage ? trackingMessage.id : null,
                    trackingChannelId: CONFIG.ACTIVE_RIDES_CHANNEL_ID
                };
                
                aktivniJizdy.set(message.author.id, jizda);
                
                // Vytvoř krásný embed pro zahájení jízdy
                const startEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('🚂 Jízda zahájena!')
                    .setDescription(`Vlak **${hledanyVlak.TrainNoLocal}** je nyní v provozu`)
                    .addFields(
                        { name: '🚉 Typ vlaku', value: hledanyVlak.TrainName || 'Bez názvu', inline: true },
                        { name: '� Start', value: hledanyVlak.StartStation, inline: true },
                        { name: '🎯 Cíl', value: hledanyVlak.EndStation, inline: true },
                        { name: '👤 Strojvůdce', value: message.author.toString(), inline: false },
                        { name: '⏰ Čas zahájení', value: `<t:${Math.floor(Date.now() / 1000)}:T>`, inline: true }
                    )
                    .setThumbnail(message.author.displayAvatarURL())
                    .setFooter({ text: `Vlak č. ${hledanyVlak.TrainNoLocal}` })
                    .setTimestamp();

                // Pošli embed do centrálního kanálu
                try {
                    const centralChannel = await client.channels.fetch(CONFIG.DISPATCHER_CHANNEL_ID);
                    await centralChannel.send({ embeds: [startEmbed] });
                } catch (error) {
                    console.error('Chyba při odesílání do centrálního kanálu:', error);
                    // Fallback do původního kanálu
                    message.reply({ embeds: [startEmbed] });
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

        // Smaž live tracking embed před ukončením jízdy
        try {
            if (aktivni.trackingMessageId && aktivni.trackingChannelId) {
                const trackingChannel = await client.channels.fetch(aktivni.trackingChannelId);
                const trackingMessage = await trackingChannel.messages.fetch(aktivni.trackingMessageId);
                await trackingMessage.delete();
                console.log(`🗑️ Smazán live tracking embed pro vlak ${aktivni.vlakCislo}`);
            }
        } catch (error) {
            console.error('❌ Chyba při mazání live tracking embedu:', error);
        }

        // Odstraň aktivní jízdu
        aktivniJizdy.delete(message.author.id);

        // Vytvoř krásný embed pro ukončení jízdy
        const endEmbed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('🏁 Jízda ukončena!')
            .setDescription(`Vlak **${aktivni.vlakCislo}** úspěšně dokončil jízdu`)
            .addFields(
                { name: '🚉 Trasa', value: `${aktivni.startStanice} → ${aktivni.cilStanice}`, inline: false },
                { name: '👤 Strojvůdce', value: message.author.toString(), inline: true },
                { name: '⏰ Doba jízdy', value: `${dobaTrvani} minut`, inline: true },
                { name: '💰 Získané body', value: `${ziskaneBody} bodů`, inline: true },
                { name: '🏆 Celkové body', value: `${stats.celkoveBody} bodů`, inline: true },
                { name: '🔥 Streak', value: `${stats.streak} jízd`, inline: true },
                { name: '🎖️ Úroveň', value: novaUroven, inline: true }
            )
            .setThumbnail(message.author.displayAvatarURL())
            .setFooter({ text: `Vlak č. ${aktivni.vlakCislo} • ${aktivni.trainName}` })
            .setTimestamp();

        // Pošli embed do centrálního kanálu
        try {
            const centralChannel = await client.channels.fetch(CONFIG.DISPATCHER_CHANNEL_ID);
            await centralChannel.send({ embeds: [endEmbed] });
        } catch (error) {
            console.error('Chyba při odesílání do centrálního kanálu:', error);
            // Fallback do původního kanálu
            message.reply({ embeds: [endEmbed] });
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
            message.reply('🏆 Žebříček je prozatím prázdný! Začněte jezdit a získávejte body pomocí `!jizda [číslo]`');
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

            // Filtruj jen stanice dostupné v SimRail (kde vlak skutečně zastavuje)
            // Stanice s časem odjezdu nebo příjezdu jsou dostupné pro hráče
            const playableStops = hledanyVlak.timetable.filter(stop => {
                // První stanice - musí mít odjezd
                if (stop === hledanyVlak.timetable[0]) {
                    return stop.departureTime && stop.departureTime !== '--:--';
                }
                // Poslední stanice - musí mít příjezd  
                if (stop === hledanyVlak.timetable[hledanyVlak.timetable.length - 1]) {
                    return stop.arrivalTime && stop.arrivalTime !== '--:--';
                }
                // Mezilehlé stanice - musí mít příjezd NEBO odjezd (ne jen projíždění)
                return (stop.arrivalTime && stop.arrivalTime !== '--:--') || 
                       (stop.departureTime && stop.departureTime !== '--:--');
            });

            // Aktualizuj hlavní embed s informacemi
            mainEmbed.spliceFields(1, 1, { name: '🚉 Stanice v SimRail', value: `${playableStops.length}`, inline: true });

            // Vytvoř embedy pro všechny stanice (rozdělené kvůli Discord limitu)
            const embeds = [mainEmbed];
            const stopsPerEmbed = 15; // Discord limit cca 4000 znaků na embed
            const totalEmbeds = Math.ceil(playableStops.length / stopsPerEmbed);

            for (let embedIndex = 0; embedIndex < totalEmbeds; embedIndex++) {
                const startIndex = embedIndex * stopsPerEmbed;
                const endIndex = Math.min(startIndex + stopsPerEmbed, playableStops.length);
                const stopsInThisEmbed = playableStops.slice(startIndex, endIndex);
                
                let trasaText = '';

                stopsInThisEmbed.forEach((stop, localIndex) => {
                    const globalIndex = startIndex + localIndex;
                    let emoji;
                    
                    if (globalIndex === 0) {
                        emoji = '🚉'; // Start
                    } else if (globalIndex === playableStops.length - 1) {
                        emoji = '🏁'; // Cíl
                    } else {
                        emoji = '▫️'; // Mezilehlá stanice
                    }

                    const arrTime = stop.arrivalTime || '--:--';
                    const depTime = stop.departureTime || '--:--';
                    const platform = stop.platform ? ` | ${stop.platform}` : '';
                    const track = stop.track ? ` | ${stop.track}` : '';
                    
                    if (globalIndex === 0) {
                        // První stanice - jen odjezd
                        trasaText += `${emoji} **${stop.nameOfPoint}** | Odjezd: **${depTime}**${platform}${track}\n`;
                    } else if (globalIndex === playableStops.length - 1) {
                        // Poslední stanice - jen příjezd
                        trasaText += `${emoji} **${stop.nameOfPoint}** | Příjezd: **${arrTime}**${platform}${track}\n`;
                    } else {
                        // Mezilehlé stanice
                        if (arrTime === depTime || depTime === '--:--') {
                            trasaText += `${emoji} ${stop.nameOfPoint} | **${arrTime}**${platform}${track}\n`;
                        } else if (arrTime === '--:--') {
                            trasaText += `${emoji} ${stop.nameOfPoint} | Odjezd: **${depTime}**${platform}${track}\n`;
                        } else {
                            trasaText += `${emoji} ${stop.nameOfPoint} | ${arrTime} - ${depTime}${platform}${track}\n`;
                        }
                    }
                });

                const routeEmbed = new EmbedBuilder()
                    .setColor('#3498db')
                    .setTitle(totalEmbeds === 1 ? '🚉 Kompletní jízdní řád' : `🚉 Jízdní řád (${embedIndex + 1}/${totalEmbeds})`)
                    .setDescription(trasaText)
                    .setFooter({ 
                        text: totalEmbeds === 1 
                            ? `${playableStops.length} stanic dostupných v SimRail • Použijte !pozice ${vlakoveCislo} pro aktuální pozici`
                            : `Stanice ${startIndex + 1}-${endIndex} z ${playableStops.length} • Použijte !pozice ${vlakoveCislo} pro pozici`
                    });

                embeds.push(routeEmbed);
            }

            message.channel.send({ embeds: embeds });

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
            message.reply('❌ Prosím, zadejte ID stanice. Příklad: `!stanice-info 422`\n💡 Pro seznam všech stanic použijte `!stanice-seznam`');
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
                message.reply(`❌ Stanice s ID **${stationId}** nebyla nalezena nebo jí neprojíždí žádné vlaky.\n💡 Použijte \`!stanice-seznam\` pro kompletní seznam stanic.`);
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

    // ===== PŘÍKAZ !STANICE-SEZNAM =====
    if (message.content.startsWith('!stanice-seznam') || message.content.startsWith('!stanice-all') || message.content.startsWith('!všechny-stanice')) {
        try {
            const response = await axios.get('https://api1.aws.simrail.eu:8082/api/getAllTimetables?serverCode=cz1');
            const vlaky = response.data;

            if (!Array.isArray(vlaky) || vlaky.length === 0) {
                message.reply('❌ Momentálně nejsou dostupná data o vlacích. Zkuste to později.');
                return;
            }

            // Získej všechny unikátní stanice
            const allStations = new Map(); // pointId -> {name, trainCount}

            vlaky.forEach(vlak => {
                if (vlak.timetable && Array.isArray(vlak.timetable)) {
                    vlak.timetable.forEach(stop => {
                        const stationId = stop.pointId;
                        const stationName = stop.nameOfPoint;
                        
                        if (stationId && stationName) {
                            if (allStations.has(stationId)) {
                                allStations.get(stationId).trainCount++;
                            } else {
                                allStations.set(stationId, {
                                    name: stationName,
                                    trainCount: 1
                                });
                            }
                        }
                    });
                }
            });

            // Převeď na pole a seřaď podle počtu vlaků (nejpoužívanější první)
            const sortedStations = Array.from(allStations.entries())
                .sort((a, b) => b[1].trainCount - a[1].trainCount);

            if (sortedStations.length === 0) {
                message.reply('❌ Nepodařilo se najít žádné stanice.');
                return;
            }

            // Hlavní embed
            const mainEmbed = new EmbedBuilder()
                .setColor('#2c3e50')
                .setTitle('🚉 Seznam všech stanic')
                .setDescription(`**Celkem nalezeno:** ${sortedStations.length} stanic\n**Seřazeno podle:** počtu projíždějících vlaků`)
                .addFields(
                    { name: '💡 Jak použít', value: 'Použijte `!stanice-info [ID]` pro detail stanice', inline: false },
                    { name: '🔝 Nejpoužívanější', value: `**${sortedStations[0][1].name}** (ID: ${sortedStations[0][0]}) - ${sortedStations[0][1].trainCount} vlaků`, inline: false }
                );

            // Rozdělíme stanice do skupin pro lepší čitelnost
            const itemsPerPage = 15;
            const totalPages = Math.ceil(sortedStations.length / itemsPerPage);
            
            // První stránka (nejpoužívanější stanice)
            const topStations = sortedStations.slice(0, itemsPerPage);
            let topStationsText = '';
            
            topStations.forEach((station, index) => {
                const [stationId, data] = station;
                const emoji = index < 3 ? ['🥇', '🥈', '🥉'][index] : '▫️';
                topStationsText += `${emoji} **${data.name}**\n   ID: \`${stationId}\` | ${data.trainCount} vlaků\n`;
            });

            const topEmbed = new EmbedBuilder()
                .setColor('#e74c3c')
                .setTitle('🏆 TOP 15 nejpoužívanějších stanic')
                .setDescription(topStationsText)
                .setFooter({ text: `Stránka 1/${totalPages} • Použijte !stanice-info [ID] pro detail` });

            // Pošli embedy
            const embeds = [mainEmbed, topEmbed];

            // Pokud je více stanic, přidej druhou stránku
            if (sortedStations.length > itemsPerPage) {
                const remainingStations = sortedStations.slice(itemsPerPage, itemsPerPage * 2);
                let remainingText = '';
                
                remainingStations.forEach(station => {
                    const [stationId, data] = station;
                    remainingText += `▫️ **${data.name}** | ID: \`${stationId}\` | ${data.trainCount} vlaků\n`;
                });

                if (remainingText.length > 0) {
                    const remainingEmbed = new EmbedBuilder()
                        .setColor('#3498db')
                        .setTitle(`📋 Další stanice (16-${Math.min(30, sortedStations.length)})`)
                        .setDescription(remainingText)
                        .setFooter({ text: `${sortedStations.length > 30 ? `... a ${sortedStations.length - 30} dalších stanic` : `Celkem ${sortedStations.length} stanic`}` });
                    
                    embeds.push(remainingEmbed);
                }
            }

            // Statistiky
            const avgTrainsPerStation = Math.round(sortedStations.reduce((sum, [_, data]) => sum + data.trainCount, 0) / sortedStations.length);
            const busyStations = sortedStations.filter(([_, data]) => data.trainCount >= 10).length;
            
            const statsEmbed = new EmbedBuilder()
                .setColor('#27ae60')
                .setTitle('📊 Statistiky stanic')
                .addFields(
                    { name: '🚉 Celkem stanic', value: `${sortedStations.length}`, inline: true },
                    { name: '🚂 Průměr vlaků/stanice', value: `${avgTrainsPerStation}`, inline: true },
                    { name: '🔥 Rušné stanice (10+ vlaků)', value: `${busyStations}`, inline: true }
                )
                .setFooter({ text: 'Data v reálném čase ze serveru cz1' });

            embeds.push(statsEmbed);
            message.channel.send({ embeds: embeds });

        } catch (error) {
            console.error('Chyba při získávání seznamu stanic:', error);
            message.reply('❌ Došlo k chybě při získávání seznamu stanic. Zkuste to později.');
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
    // ===== MODAL SUBMISSIONS =====
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'zakazka_modal') {
            await interaction.deferReply({ ephemeral: true });

            const userId = interaction.fields.getTextInputValue('zakazka_user_id');
            const vlakCislo = interaction.fields.getTextInputValue('zakazka_vlak');
            const poznamka = interaction.fields.getTextInputValue('zakazka_poznamka') || 'Bez poznámky';

            // Validace Discord ID
            if (!/^\d{17,19}$/.test(userId)) {
                await interaction.editReply({
                    content: '❌ Neplatné Discord ID! Musí být 17-19 číslic.'
                });
                return;
            }

            // Validace čísla vlaku
            if (!/^\d+$/.test(vlakCislo)) {
                await interaction.editReply({
                    content: '❌ Neplatné číslo vlaku! Musí obsahovat pouze číslice.'
                });
                return;
            }

            try {
                // Zkontroluj, jestli uživatel existuje
                const targetUser = await client.users.fetch(userId).catch(() => null);
                if (!targetUser) {
                    await interaction.editReply({
                        content: '❌ Uživatel s tímto Discord ID nebyl nalezen!'
                    });
                    return;
                }

                // Zkontroluj, jestli je uživatel na serveru
                const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
                if (!targetMember) {
                    await interaction.editReply({
                        content: '❌ Uživatel není členem tohoto serveru!'
                    });
                    return;
                }

                // Vytvoř jedinečné ID pro zakázku
                const zakazkaId = `${Date.now()}-${vlakCislo}`;
                const channelName = `zakázka-${vlakCislo}-${targetUser.username}`.toLowerCase();

                // Vytvoř kanál pro zakázku
                const zakazkaChannel = await interaction.guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: CONFIG.ZAKAZKY_CATEGORY_ID,
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id, // @everyone
                            deny: [PermissionFlagsBits.ViewChannel],
                        },
                        {
                            id: userId, // Přidělený uživatel
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                        },
                        {
                            id: interaction.user.id, // Výpravčí který vytvořil
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
                        {
                            id: CONFIG.VYPRAVCI_ROLE_ID, // Výpravčí role
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                        },
                    ],
                });

                // Embed pro zakázkový kanál
                const zakazkaEmbed = new EmbedBuilder()
                    .setColor('#e67e22')
                    .setTitle('🚂 Nová zakázka přidělena!')
                    .setDescription(`Ahoj ${targetUser}! Byla vám přidělena nová zakázka.`)
                    .addFields(
                        { name: '🚂 Vlak', value: vlakCislo, inline: true },
                        { name: '👨‍💼 Přidělil', value: interaction.user.tag, inline: true },
                        { name: '📅 Vytvořeno', value: new Date().toLocaleString('cs-CZ'), inline: true },
                        { name: '📝 Poznámka', value: poznamka, inline: false },
                        { name: '💡 Instrukce', value: 'Po dokončení jízdy klikněte na tlačítko "Dokončit zakázku" níže.', inline: false }
                    )
                    .setFooter({ text: 'MultiCargo Doprava • Systém zakázek' })
                    .setTimestamp();

                const completeButton = new ButtonBuilder()
                    .setCustomId(`complete_zakazka_${zakazkaId}`)
                    .setLabel('✅ Dokončit zakázku')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🏁');

                const cancelButton = new ButtonBuilder()
                    .setCustomId(`cancel_zakazka_${zakazkaId}`)
                    .setLabel('❌ Zrušit zakázku')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🗑️');

                const row = new ActionRowBuilder().addComponents(completeButton, cancelButton);

                await zakazkaChannel.send({ 
                    content: `${targetUser} • <@&${CONFIG.VYPRAVCI_ROLE_ID}>`,
                    embeds: [zakazkaEmbed], 
                    components: [row] 
                });

                // Ulož zakázku do mapy
                activeZakazky.set(zakazkaId, {
                    channelId: zakazkaChannel.id,
                    vypravci: interaction.user,
                    assignedUser: targetUser,
                    vlakCislo: vlakCislo,
                    poznamka: poznamka,
                    created: Date.now()
                });

                // Pošli DM uživateli
                try {
                    const dmEmbed = new EmbedBuilder()
                        .setColor('#e67e22')
                        .setTitle('🚂 Nová zakázka!')
                        .setDescription(`Byla vám přidělena nová zakázka na serveru **${interaction.guild.name}**.`)
                        .addFields(
                            { name: '🚂 Vlak', value: vlakCislo },
                            { name: '👨‍💼 Přidělil', value: interaction.user.tag },
                            { name: '📝 Poznámka', value: poznamka },
                            { name: '🎯 Co dál?', value: `Pokračujte v kanálu ${zakazkaChannel}` }
                        )
                        .setTimestamp();

                    await targetUser.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    console.log('Nepodařilo se poslat DM uživateli:', dmError.message);
                }

                await interaction.editReply({
                    content: `✅ Zakázka byla úspěšně vytvořena! Kanál: ${zakazkaChannel}`
                });

            } catch (error) {
                console.error('Chyba při vytváření zakázky:', error);
                await interaction.editReply({
                    content: '❌ Došlo k chybě při vytváření zakázky. Zkontrolujte oprávnění bota.'
                });
            }
        }
        return;
    }
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

    // Tlačítko pro vytvoření zakázky
    if (interaction.customId === 'create_zakazka') {
        // Zkontroluj oprávnění výpravčí
        if (!interaction.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID) && 
            !interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) && 
            !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            await interaction.reply({
                content: '❌ Nemáte oprávnění k vytváření zakázek! Tento příkaz mohou používat pouze výpravčí.',
                ephemeral: true
            });
            return;
        }

        // Vytvoř modal formulář
        const modal = new ModalBuilder()
            .setCustomId('zakazka_modal')
            .setTitle('🚂 Nová zakázka pro strojvůdce');

        // Input pro Discord ID
        const userIdInput = new TextInputBuilder()
            .setCustomId('zakazka_user_id')
            .setLabel('Discord ID uživatele')
            .setPlaceholder('Například: 123456789012345678')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        // Input pro číslo vlaku
        const vlakInput = new TextInputBuilder()
            .setCustomId('zakazka_vlak')
            .setLabel('Číslo vlaku')
            .setPlaceholder('Například: 24111')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(10);

        // Input pro poznámku (volitelné)
        const poznamkaInput = new TextInputBuilder()
            .setCustomId('zakazka_poznamka')
            .setLabel('Poznámka k zakázce (volitelné)')
            .setPlaceholder('Například: Důležitá přeprava, pozor na zpoždění...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500);

        const firstRow = new ActionRowBuilder().addComponents(userIdInput);
        const secondRow = new ActionRowBuilder().addComponents(vlakInput);
        const thirdRow = new ActionRowBuilder().addComponents(poznamkaInput);

        modal.addComponents(firstRow, secondRow, thirdRow);

        await interaction.showModal(modal);
    }

    // Tlačítka pro dokončení/zrušení zakázky
    if (interaction.customId.startsWith('complete_zakazka_') || interaction.customId.startsWith('cancel_zakazka_')) {
        const zakazkaId = interaction.customId.split('_').slice(2).join('_');
        const isComplete = interaction.customId.startsWith('complete_zakazka_');
        
        await interaction.deferReply({ ephemeral: true });

        // Najdi zakázku
        const zakazka = activeZakazky.get(zakazkaId);
        if (!zakazka) {
            await interaction.editReply({
                content: '❌ Zakázka nebyla nalezena nebo již byla dokončena.'
            });
            return;
        }

        // Zkontroluj oprávnění
        const isAssignedUser = interaction.user.id === zakazka.assignedUser.id;
        const isVypravci = interaction.member.roles.cache.has(CONFIG.VYPRAVCI_ROLE_ID);
        const isAdmin = interaction.member.roles.cache.has(CONFIG.ADMIN_ROLE_ID) || 
                       interaction.member.permissions.has(PermissionFlagsBits.Administrator);

        if (!isAssignedUser && !isVypravci && !isAdmin) {
            await interaction.editReply({
                content: '❌ Nemáte oprávnění k této akci!'
            });
            return;
        }

        try {
            const channel = interaction.channel;
            
            if (isComplete) {
                // Dokončení zakázky
                await interaction.editReply({
                    content: '✅ Zakázka byla označena jako dokončená! Kanál bude uzavřen za 10 sekund...'
                });

                // Vytvoř log kanál
                const logChannelName = `log-${zakazka.vlakCislo}-${zakazka.assignedUser.username}`.toLowerCase();
                const logChannel = await interaction.guild.channels.create({
                    name: logChannelName,
                    type: ChannelType.GuildText,
                    parent: CONFIG.ZAKAZKY_LOG_CATEGORY_ID,
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id, // @everyone
                            deny: [PermissionFlagsBits.ViewChannel],
                        },
                        {
                            id: CONFIG.ADMIN_ROLE_ID, // Admini
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                        },
                        {
                            id: CONFIG.VYPRAVCI_ROLE_ID, // Výpravčí
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.SendMessages,
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                        },
                    ],
                });

                // Log embed
                const logEmbed = new EmbedBuilder()
                    .setColor('#27ae60')
                    .setTitle('✅ Zakázka dokončena')
                    .addFields(
                        { name: '🚂 Vlak', value: zakazka.vlakCislo, inline: true },
                        { name: '👨‍💼 Přidělil', value: zakazka.vypravci.tag, inline: true },
                        { name: '🏁 Dokončil', value: interaction.user.tag, inline: true },
                        { name: '📅 Vytvořeno', value: new Date(zakazka.created).toLocaleString('cs-CZ'), inline: true },
                        { name: '✅ Dokončeno', value: new Date().toLocaleString('cs-CZ'), inline: true },
                        { name: '⏱️ Doba trvání', value: `${Math.round((Date.now() - zakazka.created) / (1000 * 60))} minut`, inline: true },
                        { name: '📝 Poznámka', value: zakazka.poznamka, inline: false }
                    )
                    .setFooter({ text: 'MultiCargo Doprava • Archiv zakázek' })
                    .setTimestamp();

                await logChannel.send({ embeds: [logEmbed] });

                // Pošli DM s potvrzením
                try {
                    const completionDmEmbed = new EmbedBuilder()
                        .setColor('#27ae60')
                        .setTitle('✅ Zakázka dokončena!')
                        .setDescription(`Vaše zakázka pro vlak **${zakazka.vlakCislo}** byla označena jako dokončená.`)
                        .addFields(
                            { name: '🏁 Dokončeno', value: new Date().toLocaleString('cs-CZ') },
                            { name: '📋 Archiv', value: `Záznam uložen v kanálu ${logChannel}` }
                        )
                        .setTimestamp();

                    await zakazka.assignedUser.send({ embeds: [completionDmEmbed] });
                } catch (dmError) {
                    console.log('Nepodařilo se poslat DM o dokončení:', dmError.message);
                }

            } else {
                // Zrušení zakázky
                await interaction.editReply({
                    content: '❌ Zakázka byla zrušena! Kanál bude uzavřen za 10 sekund...'
                });

                // Pošli DM o zrušení
                try {
                    const cancelDmEmbed = new EmbedBuilder()
                        .setColor('#e74c3c')
                        .setTitle('❌ Zakázka zrušena')
                        .setDescription(`Vaše zakázka pro vlak **${zakazka.vlakCislo}** byla zrušena.`)
                        .addFields(
                            { name: '🗑️ Zrušil', value: interaction.user.tag },
                            { name: '📅 Zrušeno', value: new Date().toLocaleString('cs-CZ') }
                        )
                        .setTimestamp();

                    await zakazka.assignedUser.send({ embeds: [cancelDmEmbed] });
                } catch (dmError) {
                    console.log('Nepodařilo se poslat DM o zrušení:', dmError.message);
                }
            }

            // Odstraň z aktivních zakázek
            activeZakazky.delete(zakazkaId);

            // Zavři kanál za 10 sekund
            setTimeout(() => {
                channel.delete().catch(console.error);
            }, 10000);

        } catch (error) {
            console.error('Chyba při dokončování/rušení zakázky:', error);
            await interaction.editReply({
                content: '❌ Došlo k chybě při zpracování zakázky.'
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
