---
description: Scaffold a Telegram cTrader signal parser (ctrader_gold-style), wire registerParser, and add config.json. Prompts for channel id, TG accessHash env var, and formats — keeps asking for more format examples until the user says they are done.
---

## User input

```text
$ARGUMENTS
```

Use `$ARGUMENTS` as an optional parser base name or slug (e.g. `my_gold_signals`). If empty, derive a short name from the conversation.

## Required prompts (stop and ask if missing)

Before writing files, you **must** have all of the following from the user (in this chat or in `$ARGUMENTS`):

1. **Channel id** — The Telegram channel id string used in `config.json` (e.g. `2385521106`). Must match the channel the harvester will read from.
2. **Telegram accessHash** — The **environment variable name** for the channel access hash (e.g. `TG_ACCESS_HASH_MY_SIGNALS`), not the secret value. Harvesters use `envVarNames.accessHash` pointing at this name, with `apiId` typically `TG_API_ID` like `ctrader_gold_harvester`.
3. **Formats to parse** — Collected as below; do not treat a single message as complete unless the user says so.

If any of (1) or (2) are missing, ask concise follow-up questions; do not invent credentials or channel ids.

### Formats: keep asking until the user is done

Do **not** implement or edit code until the user has **finished listing all formats** they want supported.

- After the user gives **each** format (examples and any notes), reply with a **short acknowledgment** (e.g. “Recorded as Format N”) and ask again: **“Send another format example, or say you’re done (e.g. `done`, `no more formats`, `that’s all`, `finished`).”**
- **Accept as “done”** clear signals such as: `done`, `no more`, `no more formats`, `that’s all`, `finished`, `none left`, `stop`, or equivalent. If unsure, ask once: “Any more formats, or proceed with implementation?”
- **Accumulate** every example into a numbered list in your own notes so nothing is dropped; the final parser file header comment should document **all** formats (same spirit as “Format 1 / 2 / 3” in `src/parsers/ctraderGoldParser.ts`).
- If the user adds formats **after** you already implemented, treat that as a **follow-up**: extend the same parser (and tests if any) rather than overwriting unrelated behavior.

Only when (1), (2), and the full format list (3) are settled should you run the **Implementation steps** below.

## Goal

Create a new parser **like** `ctrader_gold` (`src/parsers/ctraderGoldParser.ts`), register it, and add `config.json` entries that mirror:

- **Harvester**: same shape as `ctrader_gold_harvester` in `config.json` (`pollInterval`, `downloadImages`, `skipOldMessagesOnStartup`, `maxMessageAgeMinutes`, `envVarNames.apiId` + `envVarNames.accessHash`), but with a **new unique `name`**, **`channel`**: the user-provided channel id string, and the user-provided `accessHash` env var name.
- **Parser list entry**: `{ "name": "<parser_name>", "channel": "<user_channel_id>" }` — same pattern as `ctrader_gold` under `parsers`.
- **Channels entry**: same structure as an existing cTrader Telegram channel block in `config.json` — use **`2385521106`** (“big”) as the reference shape (ctrader initiator/monitor, breakeven, risk, leverage, propFirms, tradeObfuscation, etc.). `3469900302` (ctrader_gold VIP) is another valid template if you need extra fields. Set **`channel`** to the user’s id and **`harvester`** / **`parser`** to the new harvester and parser names.

**Note:** If that channel id already has a harvester/parser pair, explain that only one harvester should own that channel id in practice; the user may need to remove or rename the old pair, or pick a different channel. Do not silently duplicate conflicting harvesters for the same channel without calling this out.

## Implementation steps

1. **Naming**: Choose a stable parser id (snake_case), e.g. `ctrader_<slug>`, and matching harvester name `<parser_id>_harvester`. New parser **file**: `src/parsers/<Name>Parser.ts` exporting `<name>Parser` (match existing style: `ctraderGoldParser` in `ctraderGoldParser.ts`).
2. **Parser logic**: Start from `ctraderGoldParser.ts` (same `ParsedOrder` / `validateParsedOrder` / `deduplicateTakeProfits` patterns). Implement **every** format the user confirmed (try each variant in order, or unify into one robust parse path). Keep behavior aligned with cTrader gold signals unless the formats clearly require otherwise.
3. **Registration**: Register the parser in both places that register `ctrader_gold`:
   - `src/parsers/signalParser.ts`
   - `src/orchestrator/tradeOrchestrator.ts`
4. **config.json**: Insert the new harvester in `harvesters`, new object in `parsers`, and new object in `channels` (or update the existing channel block if the user is replacing the old wiring). Preserve JSON validity and trailing commas rules; match surrounding indentation.
5. **Verify**: Ensure imports use `.js` extensions consistent with the repo; run the project linter or `tsc` if available.

## Done when

- The user explicitly ended the format list (per **Formats: keep asking until the user is done**).
- New parser file exists and implements **all** described formats.
- Both registration sites include `registerParser('<parser_id>', <parserExport>)`.
- `config.json` contains a Telegram-style harvester for the user’s channel id with the user’s accessHash env var name, plus matching `parsers` and `channels` entries in the style of the **`2385521106`** channel block (or similar cTrader Telegram setup).
