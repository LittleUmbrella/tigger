I want to build a crypto trading bot written in typescript. It should consist of the following

- signal harvestors
- signal parsers
- signal initiators
- trade monitors
- a trade orchestrator to orchestrate all of the above

These components should be written as functional components, not classes.

The harvestors should be long-running, long-polling telegram message readers, similar to .src/index.js, but just get the latest messages. Messages should be stored in a database. The bot can run any number of harvestors, each configurable for a different telegram channel.

The parsers will be 1:1 with the harvestors. They will parse the messages received into a set of order data: a trading pair, leverage to use, an entry price, a stop-loss price, and any number of take-profit prices. An example message to parse is this: "⚡️© PERP/USDT ©⚡️ Exchanges: Pionex, Binance, Bybit Signal Type: Regular (Short) Leverage: 5x-10х Use 3-5% Of Portfolio Entry Targets: 0.7034 🖖🏽 0.717605 Take-Profit Targets: 1) 0.68919 2) 0.67498 3) 0.65366 4) 0.63945 5) 0.61814 6) 0.59682 8) 0.56840 7) 🚀🚀🚀 Stop Targets: 0.76024"

Similarly, the initiators will be 1:1 with the harvestors. They will take the set of order data and initiate actual orders. Some initiators will initiate on the bybit crypto exchange, using futures apis. These should use an appropriate open-source bybit client. Others will initiate on a dex crypto exhange, but none have been identified as yet, so the is a future feature. They need to be configured to use one or the other exchange, and should be configurable with a risk percentage that will be used to calculate how much of total account balance should be risked for the trade (if the stop-loss were hit). The orders should be saved in a database.

The trade monitors will monitor open trades using long-polling. Any time the first take-profit price is hit, the monitor will edit and/or cancel/recreate the stop-loss to be the same as the entry price. The monitors will also monitor if price hits either the sl or tp before the entry price, in which case the order will be cancelled. Also, if the entry is not met in 2 days (must be configurable), the order will also be cancelled.

These all need to be configured via a json file.

The orchestrator will read the json file and kick all the above off.

Use generous logging throughout.

It makes sense to store messages and trades in a database. 

All this should be dockerized.
