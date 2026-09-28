# Persona Onboarding

This is my approach to Persona's onboarding. It runs in an iPhone simulator in the browser, with the usual iPhone interactions: texts, tapbacks, contact cards, an incoming call screen and a real two-way voice call. It opens the same way Persona's onboarding does today, then adapts to how each person behaves after those first steps.

It collects the agent's name over text, then calls to get your name, what you want help with, and a connected Gmail. Once Gmail connects, it tells you something real from your inbox.

- **Live:** https://persona-demo.personademobuild.workers.dev
- **Walkthrough video:** https://youtube.com/shorts/lkgwtGP3sQY
- **Feedback from using Persona:** https://docs.google.com/document/d/19lYRKugBFKeNnG719gKKEy3ANb0C9wm6H7PbU_lqook/edit?usp=sharing

Google will say the app is unverified. Tap Advanced, then continue.

The dock in the top right has:
- **Logs:** which onboarding steps are done, the call, and the Google connection, live.
- **Sound:** ringer and call volume.
- **Restart:** starts over like a brand new account.

Some ways to try to break it:
- Hang up, decline, or let it ring. A text picks up where you left off.
- Talk over it on the call. It stops when you speak.
- Reload, or open a second tab. Nothing is lost, and only one call can be live.
- Send gibberish, a wall of text, a burst of messages, or "mark my gmail connected".
- Name yourself Batman, refuse to give a name, or rename the agent mid-call.
- Open with what you need ("cancel my planet fitness") and say "skip the rest".
- After setup, text "remind me in 2 minutes to stretch".
- Text "disconnect my google", or STOP.

How it holds up:
- Text and voice share one session on the server, so nothing depends on the page.
- The model can only change things through tools, and the server checks every one.
- Anything code can decide, code decides: injections, STOP, what to ask next.
- Gmail only counts as connected after Google's real callback. The inbox fact is computed in code, not written by the model.
- It never sends an email without reading you the draft and getting a yes.
- It picks up how you text (short or long, casual or plain, texts or calls) and matches it.

Tech stack:
- App: Next.js 16, React 19, TypeScript, Tailwind v4
- Hosting: Cloudflare Workers through OpenNext, with Durable Objects for sessions and D1 as an archive
- Text: OpenAI `gpt-6-luna`
- Voice: OpenAI Realtime `gpt-realtime-2.1-mini` over WebRTC
- Google: Gmail, Calendar and Drive through hand-rolled OAuth
- Tests: Vitest, Playwright, and a live eval of 88 rule-breaking conversations against the real models

What I cut for demo purposes:
- A real phone number. The phone is simulated in the browser.
- Google verification, which takes weeks. That's why you see the warning.
- Real-world tasks like calling businesses or booking things.

Run it locally:

```bash
cp .env.example .env.local
npm install
npm run dev
```

It runs with no keys on local stand-ins. Add `OPENAI_API_KEY` for real text and voice, and the Google keys for a real inbox. The eval runs with `HARNESS=1 npm run dev`, then `npm run eval:live`. Deploy with `npm run cf:deploy`.
