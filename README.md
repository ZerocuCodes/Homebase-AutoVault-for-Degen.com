# HomeBase AutoVault

A userscript (Tampermonkey/Greasemonkey/Violentmonkey) that automatically vaults a percentage of your profits on [degen.com](https://degen.com) into the site's built-in vault, so winnings get locked away instead of getting played back.

## What it does

- Watches your wallet balance on degen.com via the site's own account API (read-only balance checks, no scraping).
- Whenever your balance goes up, sends a configurable percentage of the profit to your Degen vault.
- Detects "big wins" (balance jumping past a configurable multiplier) and vaults a larger percentage on those.
- Automatically tracks whichever currency is currently primary on Degen — it never forces a currency switch, it just follows your account's selection.
- Ships with a draggable, theme-matched floating widget (full / minimized / stealth-dot view) showing wallet balance, vault balance, and vaulting activity in real time.
- Respects rate limits: tracks both the API's own rate-limit headers and a client-side cap (50 actions/hour) before attempting a deposit.

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Firefox/Edge), Violentmonkey, or Greasemonkey.
2. Open the extension dashboard and create a new script.
3. Copy the contents of [degenautovault.js](degenautovault.js) into it and save.
4. Visit [degen.com](https://degen.com) — the DegenVault widget will appear a couple seconds after the page loads.

## Configuration

All settings are adjustable from the widget UI and persist in `localStorage`:

| Setting | Description | Default |
|---|---|---|
| Save % | Fraction of each profit vaulted (e.g. `0.1` = 10%) | `0.1` |
| Big Win Threshold | Balance multiple that counts as a "big win" (e.g. `5` = 5x growth) | `5` |
| Big Win Multiplier | Multiplies Save % on a big win instead of using it directly | `3` |
| Check Interval | How often (seconds) the script polls your balance | `90` |

Click **Start** in the widget to begin monitoring, **Stop** to pause. Use the sync button (⟳) to force a re-check of the currently tracked currency.

## Disclaimer

This script only reads your balance and issues vault deposits through Degen's own account API — it does not place bets, execute trades, or move funds anywhere outside your own Degen vault. Use at your own risk and in accordance with Degen's terms of service.
