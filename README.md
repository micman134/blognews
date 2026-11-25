# Blog frame bot

Users upload a short video; the bot returns it inside their blog-post frame
(blog name + handle on top, headline, social handles card on one side, video on the other).

## Run
1. `npm install`
2. Copy `.env.example` to `.env` and set `BOT_TOKEN`
3. `npm start`

ffmpeg comes from the `ffmpeg-static` package; set `FFMPEG_PATH` to use your own.
Saved blog details live in `DATA_DIR/data.json`. On hosts with a temporary disk (e.g. Render free), point `DATA_DIR` at a persistent volume.
For colour emojis on Linux: `apt install fonts-noto-color-emoji`.

## Limits
Telegram lets bots download files up to 20 MB and upload up to 50 MB.
