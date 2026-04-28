# octocode-gateway

Messaging gateway adapter. MVP includes a stub-friendly Telegram Bot API
client built on a `MessageTransport` trait so any HTTP client (ureq,
reqwest, mock) can be injected at the boundary.

## Configuration

Set the bot token via environment variable before constructing
`TelegramGateway`:

```powershell
$env:OCTOCODE_TELEGRAM_TOKEN = '123456:ABC...'
```

```rust
use octocode_gateway::{TelegramGateway, OutboundMessage, MessageTransport};

let token = std::env::var("OCTOCODE_TELEGRAM_TOKEN")?;
let gw = TelegramGateway::new(token);
let username = gw.get_me(&my_transport)?;
gw.send_message(&my_transport, &OutboundMessage {
    chat_id: "12345".into(),
    text: "build green".into(),
})?;
```

## Status

- [x] `MessageTransport` trait
- [x] Telegram `getMe` / `sendMessage`
- [x] Mock-transport unit tests
- [ ] Real `ureq` transport (next slice)
- [ ] Inbound webhook ingest (next slice)
- [ ] Discord / Slack / Email backends
