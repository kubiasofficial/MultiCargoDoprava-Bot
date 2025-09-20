# MultiCargo Doprava Discord Bot

Discord bot pro komunitu MultiCargo Doprava zaměřený na SimRail vlaky a železniční dopravu.

## Funkce

- **!jizda** - Vyhledání vlaků v SimRail s detailními informacemi
- **Žádosti o členství** - Systém žádostí s admin schválením
- **Bodový systém** - Sledování jízd a úrovní uživatelů
- **Centralizované zprávy** - Všechny zprávy se posílají do dispatcher kanálu
- **Anti-spam** - Eliminace spamu díky centralizaci odpovědí

## Instalace

1. Klonuj repository:
```bash
git clone https://github.com/kubiasofficial/MultiCargoDoprava-Bot.git
cd MultiCargoDoprava-Bot
```

2. Nainstaluj závislosti:
```bash
npm install
```

3. Vytvoř `.env` soubor podle `.env.example`:
```bash
cp .env.example .env
```

4. Vyplň Discord token do `.env` souboru:
```
DISCORD_TOKEN=tvůj_discord_token_zde
```

5. Spusti bota:
```bash
npm start
```

## Konfigurace

### Environment Variables
- `DISCORD_TOKEN` - Token Discord bota (povinné)

### Nastavení kanálů
V `index.js` můžete upravit ID kanálů:
- `DISPATCHER_CHANNEL_ID` - ID kanálu pro centralizované zprávy
- `APPLICATION_CHANNEL_ID` - ID kanálu pro žádosti

## Hosting na Railway

1. Vytvoř projekt na [Railway.app](https://railway.app)
2. Propoj s GitHub repository
3. Nastav environment variable `DISCORD_TOKEN`
4. Deploy se spustí automaticky

## Commands

- `/jizda [číslo_vlaku]` - Vyhledání vlaku v SimRail
- `/zadost` - Podání žádosti o členství
- `/profil [uživatel]` - Zobrazení profilu a statistik
- `/admin schvalit/zamitnout` - Admin příkazy pro žádosti

## Struktura

- `index.js` - Hlavní soubor bota
- `package.json` - Závislosti a metadata
- `.env.example` - Template pro environment variables
- `.gitignore` - Soubory ignorované Gitem

## Závislosti

- `discord.js` - Discord API knihovna
- `axios` - HTTP klient pro SimRail API
- `dotenv` - Správa environment variables

## Autor

Vytvořeno pro komunitu MultiCargo Doprava

## Licence

MIT License