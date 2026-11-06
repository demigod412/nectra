/* ==========================================================================
   AI Copilot — Claude turns plain English into a strategy *intent*
   (structured output, validated with zod). server/strategy.js then builds
   the exact bot config deterministically, so the model can never produce a
   config the engine doesn't understand. Without ANTHROPIC_API_KEY (or when
   the call fails) the rule-based parser is used instead.
   ========================================================================== */
'use strict';
const { z } = require('zod');
const strategy = require('./strategy');
const market = require('./market');
const { getSettings } = require('./db');

const MODEL = process.env.COPILOT_MODEL || 'claude-opus-5-5';
let client = null;
function getClient() {
  if (client !== null) return client;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return (client = false);
  const Anthropic = require('@anthropic-ai/sdk').default;
  client = new Anthropic();
  return client;
}
const enabled = () => !!getClient() && getSettings().ai_copilot !== false;

const Intent = z.object({
  strategy: z.enum(['DCA', 'Grid', 'Momentum', 'Scalp', 'Breakout', 'Dip-buy', 'Mean-reversion', 'Copy-trader', 'Arbitrage', 'Guardrail', 'unsupported']),
  token: z.string().nullable(),
  amount_usd: z.number().nullable(),
  interval: z.enum(['hourly', 'daily', 'weekly']).nullable(),
  weekday: z.string().nullable(),
  range_low: z.number().nullable(),
  range_high: z.number().nullable(),
  dip_pct: z.number().nullable(),
  stop_loss_pct: z.number().nullable(),
  take_profit_pct: z.number().nullable(),
  breakout_window: z.number().nullable(),
  trail: z.boolean().nullable(),
  max_position_usd: z.number().nullable(),
  leader: z.string().nullable(),
  drop_pct: z.number().nullable(),
  explanation: z.string(),
  clarification: z.string().nullable()
});

const SYSTEM = `You are the strategy parser inside NECTRA, a crypto trading app where every bot starts in paper trading and the user must review and confirm every strategy before it runs.

Convert the user's plain-English request into exactly one strategy intent:
- DCA: buy a fixed USD amount of a token on a schedule (amount_usd, interval, weekday for weekly).
- Grid: buy/sell a ladder of orders inside a price range (range_low, range_high in USD; max_position_usd optional).
- Momentum: buy when price breaks above its moving average; stop_loss_pct / take_profit_pct / max_position_usd / trail optional.
- Scalp: many small, fast trades off a short moving average, taking quick profits; take_profit_pct is small (e.g. 0.5), stop_loss_pct small, trail optional. Use when the user says scalp, scalping, quick/small gains, or in-and-out.
- Breakout: buy when price breaks above its recent high over breakout_window hours; stop_loss_pct / take_profit_pct / trail optional. Use when the user says breakout, break above, or buy new highs.
- Dip-buy: buy amount_usd once price falls dip_pct %; stop/take-profit optional.
- Mean-reversion: buy when price is dip_pct % under its recent average, sell at the average.
- Copy-trader: mirror a leader handle with max_position_usd.
- Arbitrage: capture price gaps, max_position_usd.
- Guardrail: pause all bots if the portfolio drops drop_pct % (not a trading bot).
- unsupported: anything else (leverage, shorting, tokens not in the list, transfers, advice requests). Explain briefly in clarification.

Supported tokens: ${strategy.TOKENS.join(', ')}. Quote currency is always USDC.
Set trail=true only if the user explicitly asks for a trailing stop (e.g. "trail", "trailing stop", "lock in gains as it rises").
Use null for any field the user did not specify — never invent amounts or prices; the app applies safe defaults.
Never promise or imply profits, and never claim one strategy earns more than another.
If the request is ambiguous in a way that changes money at risk (e.g. no amount for DCA), still pick the best strategy and ask in clarification.
explanation: one short sentence, in the user's language, describing what the strategy will do.
Never give financial advice or predict prices.`;

/** Returns { strategy, explanation, clarification, engine } or throws */
async function parseWithClaude(text, previous) {
  const c = getClient();
  const prices = market.tokens().filter((t) => strategy.TOKENS.includes(t.sym)).map((t) => `${t.sym}=$${t.price.toPrecision(5)}`).join(', ');
  const userContent = `Current prices: ${prices}\n${previous ? `The user is editing this earlier strategy intent: ${JSON.stringify(previous)}\n` : ''}Request: ${text}`;
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  const res = await c.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: zodOutputFormat(Intent) },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }]
  });
  if (res.stop_reason === 'refusal') throw new Error('refused');
  const intent = res.parsed_output;
  if (!intent) throw new Error('unparsed');
  return { intent, explanation: intent.explanation, clarification: intent.clarification, engine: 'claude' };
}

/** Main entry: Claude when configured, rules otherwise (or on any failure) */
async function parse(text, previous) {
  if (enabled()) {
    try {
      const r = await parseWithClaude(text, previous);
      if (r.intent.strategy === 'unsupported') return { strategy: null, clarification: r.clarification || 'That isn’t something a NECTRA bot can do yet.', engine: 'claude' };
      return { strategy: strategy.buildStrategy(r.intent), intent: r.intent, explanation: r.explanation, clarification: r.clarification, engine: 'claude' };
    } catch (e) {
      console.warn('[copilot] Claude unavailable, using rules:', e.status || '', e.message);
    }
  }
  const intent = strategy.intentFromText(text);
  return { strategy: strategy.buildStrategy(intent), intent, engine: 'rules' };
}

module.exports = { parse, enabled, MODEL };
