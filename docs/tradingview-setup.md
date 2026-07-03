# TradingView setup

1. Open a chart in TradingView and create a new **Alert** (right-click the chart, or use the
   Alert panel).
2. Set your condition (indicator crossover, price level, custom Pine Script `alertcondition`,
   etc).
3. Under **Notifications**, enable **Webhook URL** and enter:

   ```
   http://<your-backend-host>:4000/api/webhooks/tradingview
   ```

   For local development with TradingView (a cloud service) reaching a backend on your machine,
   you'll need to expose your local port with a tunnel (e.g. `ngrok http 4000`) and use the
   tunnel's HTTPS URL instead of `localhost`.

4. In the **Message** field, enter JSON matching the shape documented in
   `docs/webhook-payload.md`. You can use TradingView's alert placeholders
   (`{{ticker}}`, `{{close}}`, `{{interval}}`, `{{time}}`, etc.) inside the JSON string values,
   for example:

   ```json
   {
     "secret": "change-me",
     "symbol": "{{ticker}}",
     "assetType": "crypto",
     "timeframe": "{{interval}}",
     "price": {{close}},
     "signal": "LONG",
     "triggeredAt": "{{time}}",
     "exchange": "BINANCE"
   }
   ```

5. Make sure the `secret` value matches `WEBHOOK_SECRET` in `apps/backend/.env` exactly.
6. Save the alert. The dashboard's Settings page (`/settings`) always shows the exact webhook URL
   and a sample payload for your running instance.

## Testing without TradingView

Use the curl example in the root `README.md` to simulate a webhook call directly — this is the
fastest way to verify the full pipeline (screenshot + AI analysis + realtime updates) before
wiring up a real TradingView alert.
