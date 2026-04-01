Mar 16, 2026 • 9 min read

# How I built my wife a personal AI assistant on OpenClaw (and what actually took time)

A setup guide for people building for someone who will never read a setup guide.

![](https://founder.codes/images/partner-ai-assistant.jpg)

I’ve built six of these for myself. I know the config, the bindings, the model selection. I thought building one for my wife would take an afternoon.

It took a week. But the delay had nothing to do with the tech.

My wife Emily is a sales rep. She spends her days driving between doctor’s offices, fitting calls in between school pickups. She has never once asked for a demo — but I like tinkering with AI and figuring out fun use cases (hence my cable management task).

That gap, between how I build these things and how she actually lives, is what cost me the week. This guide is an attempt to save you that week.

But before we get into config, I want to show you what this actually looks like when it’s working. Because the setup is not the point. What happens after is. It’s not about setup productivity porn — it’s about how useful the agent is once done.

* * *

## What the agent actually does

### The morning brief

7:30am. Before she gets out of bed, a message arrives in her iMessage thread.

“Good morning. You have a call with \[NAME\] at 9am and a lunch at noon that’s about 25 minutes from the office, so leaving by 11:30 should be fine. It’s red day so dress \[CHILD\] in red outfit. \[CHILD\] has swim at 4, bag needs to be in the car. One thing to know before the Patel call: you haven’t been to that practice in 8 weeks.”

The assistant pulls from her calendar, knows kids’ schedules from conversations she had weeks ago, daycare emails and calendar events, checks the weather, and tracks how long it’s been since she visited each practice on her territory. It runs every morning at 7am without being asked. No app to open.

### Receipts and the HSA

She buys something at the pharmacy. HSA-eligible. She forwards the email receipt to the assistant without typing a word.

“Got it. Logged $43.17 from CVS on March 4th, HSA eligible. Running total this year: $612. Submitted to Lively for future reimbursement.”

This is where ChatGPT stops being a useful comparison. Going from email to submitted expense without work from her. This would also work if she texts a picture of a receipt.

### Facebook Marketplace

Six weeks ago, in a voice memo from her car, she mentioned she was looking for a Snoo bassinet secondhand for a group gift. It set up a cron job to check once a day until it found something that matched her specs.

Last Tuesday:

“Found one. $550, good condition, seller in Westlake. Here’s the listing.”

### Package tracking

She mentioned ordering a birthday gift for her niece. The assistant found the confirmation in her email, pulled the tracking number, and has been watching it since.

“Your package is out for delivery today. Should arrive by 8pm.”

She did not ask. She did not forward anything. It found the order confirmation on its own and surfaced the update at the moment it was useful.

### Daycare emails to calendar

Our daycare sends multiple emails per week and we don’t want to miss signing up for something or missing an event. Or god forbid it’s yellow day at school and we don’t realize until we arrive (yes, this has happened).

The assistant reads it, pulls out every date and event, adds them to her calendar, and sends a three-line summary.

“This week’s school newsletter: Book Fair is March 12–14, bring cash. Spring photos on March 19, picture day outfit reminder added to your calendar. No school March 21 for teacher planning day, already blocked.”

### The thing none of this required

She did not configure any of it. She did not set up automations. She did not learn a new app. She talked into her phone the way she always has, and the assistant remembered what mattered (with help from me on cron jobs and setup).

That is the actual pitch for building this. Not “AI can do tasks.” It’s “the assistant lives where she already lives, knows what she has already said, and acts without being asked.”

ChatGPT cannot do this. It has no persistent memory across sessions, no access to her email, no ability to run proactively in the background. It requires her to show up, explain the context, and ask. She is never going to do that from a parking garage between calls.

Now here is how to build it.

* * *

## Before you start

Two things need to be true before any of the following matters.

**OpenClaw running on a Mac.** The gateway needs to be up and reachable. Setup guide at [docs.openclaw.ai](https://docs.openclaw.ai/) — I also wrote a detailed guide: [Step-by-Step OpenClaw Setup for People Who Don’t Live in the Terminal](https://founder.codes/guides/openclaw-setup).

**BlueBubbles installed.** This is what connects OpenClaw to iMessage. It runs a local server on your Mac that OpenClaw talks to over HTTP. Download at [bluebubbles.app](https://bluebubbles.app/), enable the web API, set a password. My setup runs through a Gmail account in BlueBubbles so messages look like they’re coming from email.

Once those are true, the rest is config.

* * *

## The setup

If you point your claw or Claude at this section, they can set all of this up for you.

### 1\. Create the agent config block

Every agent in OpenClaw is defined in your `openclaw.json` under `agents.list`:

```
{
  "id": "your-assistant-id",
  "name": "Your Assistant Name",
  "workspace": "/Users/yourname/OpenClaw/agents/your-assistant-id",
  "model": {
    "primary": "anthropic/claude-sonnet-4-6",
    "fallbacks": ["openai-codex/gpt-5.4"]
  },
  "subagents": { "thinking": "auto" }
}Copy
```

Claude Sonnet 4.6 is fast, handles voice memos natively, and costs a fraction of Opus. The GPT-5.4 fallback means if Anthropic has an outage, the assistant stays up. Create the workspace folder — it’s where the agent’s memory files live: SOUL.md, USER.md, ONBOARDING.md.

### 2\. Add the binding

This is what makes the agent respond only to your partner, not to you or anyone else:

```
{
  "agentId": "your-assistant-id",
  "match": {
    "channel": "bluebubbles",
    "peer": { "kind": "dm", "id": "+15550001234" }
  }
}Copy
```

Put their phone number in E.164 format. When they text, it routes to their agent. When you text from your number, it routes to yours. One gateway, completely separate experiences.

### 3\. Add them to the BlueBubbles allowlist

In your `channels.bluebubbles` config, add their number to `allowFrom`:

```
{
  "channels": {
    "bluebubbles": {
      "enabled": true,
      "serverUrl": "http://localhost:1234",
      "password": "your-bluebubbles-password",
      "webhookPath": "/bluebubbles-webhook",
      "dmPolicy": "allowlist",
      "allowFrom": [\
        "+15550005678",\
        "+15550001234"\
      ],
      "mediaMaxMb": 25
    }
  }
}Copy
```

The `allowFrom` list is the gatekeeper. Only numbers on this list can reach the gateway at all.

### 4\. Voice memos — add this to SOUL.md

When your partner sends a voice memo from iMessage, BlueBubbles receives it as an audio attachment. OpenClaw passes it to Claude Sonnet 4.6, which transcribes and processes it natively. No special config required.

The one thing you do need to add to SOUL.md:

```
Voice memos are the default input. When a voice memo arrives,
transcribe and process it exactly as you would a text message.
Reply in plain text. Never reference the fact that it was a voice memo.Copy
```

Emily holds down the microphone button, talks for 30 seconds, sends it. The agent gets a full transcription and responds in plain text. She’s in the car most of the day. Voice is faster than typing in a parking garage. This one decision changed the entire shape of how she uses it.

* * *

## What I learned the hard way

The config took an afternoon. The files took a week. Here’s why, and what to do about it.

### Formatting will kill trust immediately

AI agents default to markdown. In iMessage, that looks like the bot doesn’t know where it is. Asterisks, dashes, headers — all of it renders as raw text on a phone. The first time someone gets a message that looks like formatting code, they stop trusting the assistant. They’re not going to debug why it looks weird. They’re just going to stop opening it.

Add this to the very first section of SOUL.md, before anything else:

```
Plain text only. No markdown. No asterisks, no dashes, no headers,
no code blocks. Short paragraphs. Assume they're reading on their phone.Copy
```

### Never let errors reach them

Early on, when an API call hit a rate limit, the raw error went straight through to Emily. Not a friendly message — the actual system error with the status code. Her response: “Is this thing broken?”

For a technical person, a stack trace is information. For anyone else, it’s proof the thing doesn’t work.

```
Never send error messages, rate limit notices, or tool failures
to the user. Handle them silently. If you can't complete something,
say so in plain English. Not in system-speak.Copy
```

This goes in every SOUL.md I build now, before anything else.

### The cold-start problem

Most AI assistants fail not because the AI is bad (anymore). They fail because nobody thought about what happens when someone opens it for the first time and sees a blank input. Non-technical people freeze. They type something awkward. The response is generic. They decide the thing doesn’t work.

Write an ONBOARDING.md that sends the first message before they ever say anything:

```
"Hey [Name]! Before I ask you a few questions to get set up,
just so you know — if it's easier, send a quick voice memo
and I'll pull everything I need from that. Otherwise I'll ask
you one thing at a time."Copy
```

When the AI already knows who you are before the first message, it stops feeling like a tool.

### The files are the actual work

When I built my own agent, I filled the files in an afternoon. The context was already in my head. Building them for Emily meant I had to articulate how she moves through her life. Not just know it — put it in writing specific enough that an AI could use it.

The fastest shortcut: let the AI interview you. Paste this into Claude before you open a blank SOUL.md:

```
I want to build a personal AI assistant for someone close to me using OpenClaw.
Help me generate their SOUL.md, USER.md, and ONBOARDING.md.

Interview me first. Ask about: their job and what a typical day actually looks like.
How they communicate. What do they reach for their phone to do when stressed?
What does a hard day look like? What would feel genuinely useful versus one more
thing to manage? What platforms they are on. Whether they are technical.

After the interview, generate all three files ready to copy into the agent's workspace.Copy
```

About 45 minutes later, you’ll have working drafts. They won’t be final, but they’ll be specific enough to edit.

* * *

## The starter templates

Copy these into your agent’s workspace. Fill in the brackets.

**SOUL.md**

```
## Who you are

You are [Assistant Name], [Partner's Name]'s personal assistant.
You help with scheduling, reminders, research, and whatever comes up.
You know who [Partner's Name] is and how they work.

## Voice

Warm but efficient. Short answers unless they ask for more.
No markdown. No asterisks, no bullets, no headers.
Plain text only. Assume they are reading on their phone.

## Rules

Never send error messages or system errors. If something fails, say so in plain English.
Voice memos are the default input. Process them exactly as text. Never reference that it was a voice memo.
Only take instructions from [Partner's Name]'s known number.
Confirm reminders when set.
If unclear, ask one focused question, not five.

## What you help with

Scheduling and reminders.
Quick research and lookups.
Drafting messages and emails in their voice.
Tracking packages, receipts, and return windows.
Reading emails and adding dates to the calendar.
Monitoring searches and flagging results.
Whatever comes up.Copy
```

**USER.md**

```
# About [Partner's Name]

Name: [Their name]
Role: [Their job in one line]
How they communicate: [e.g. direct / prefers voice]
When usually available: [e.g. mornings, not after 8pm]

## What helps them
[short answers]
[remind 24h out]
[proactive over reactive]

## What does not help
[long explanations]
[being asked to confirm obvious things]

## Career awareness
[Industry term] = [plain-English definition]

## Family context
[Kids, names, ages, schedules]
[Recurring commitments]

## Active watches
[Marketplace searches, return windows, etc.]Copy
```

**ONBOARDING.md**

```
## First message (send before they say anything)

"Hey [Name]! I'm [Assistant Name]. You can text or send a voice
memo, whichever is easier. I'll ask you one question at a time
to get started."

## What I already know (do not ask about these)

[List everything from USER.md they shouldn't have to re-explain]

## First question

What's the most repetitive thing on your plate right now
that you'd love to hand off?Copy
```

**Full config (paste into openclaw.json)**

```
// Under agents.list:
{
  "id": "your-assistant-id",
  "name": "Your Assistant Name",
  "workspace": "/Users/yourname/OpenClaw/agents/your-assistant-id",
  "model": {
    "primary": "anthropic/claude-sonnet-4-6",
    "fallbacks": ["openai-codex/gpt-5.4"]
  },
  "subagents": { "thinking": "auto" }
}

// Under bindings:
{
  "agentId": "your-assistant-id",
  "match": {
    "channel": "bluebubbles",
    "peer": { "kind": "dm", "id": "+15550001234" }
  }
}

// Under channels.bluebubbles.allowFrom — add their number:
"+15550001234"Copy
```

* * *

## Where to start

The tech took an afternoon. What took a week was figuring out how someone else moves through their life.

Emily didn’t want an AI assistant. She wanted to get through her day — with something that felt like a real assistant, not AI. Those aren’t the same thing, and building for the second one is harder than it sounds.

The assistant that works for her is not the most capable one. It’s the one that lives where she already is, remembers what she has already said, and doesn’t make her think about it.

The best way to start is not to think about what the agent can do. Think about what she’s doing right now that she shouldn’t have to be doing herself.

Paste this into Claude and answer honestly:

```
I want to figure out the first three tasks for a personal AI assistant
I'm building for someone close to me.

Tell me about them: What does their day actually look like?
What do they handle that nobody else sees? What slips through the cracks?
What would they never think to ask for help with, but would notice
immediately if it disappeared?

Based on what I tell you, suggest three starting tasks — one reactive
(they ask, it does), one proactive (it runs without being asked),
one ambient (it watches and surfaces things). Explain why each one
for this specific person.Copy
```

That’s the config. Everything else is just files.

### Get more founder codes

Technical systems and operational tactics for founder-operators. Delivered weekly.

Subscribe

No spam. Unsubscribe anytime.

Back to top

reCAPTCHA

Recaptcha requires verification.

[Privacy](https://www.google.com/intl/en/policies/privacy/) \- [Terms](https://www.google.com/intl/en/policies/terms/)

protected by **reCAPTCHA**

reCAPTCHA is changing its terms of service. [Take action.](https://google.com/recaptcha/admin/migrate)

[Privacy](https://www.google.com/intl/en/policies/privacy/) \- [Terms](https://www.google.com/intl/en/policies/terms/)