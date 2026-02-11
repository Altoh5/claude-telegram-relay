# Frequently Asked Questions

---

## Deployment & Costs

### Can I run the bot 24/7 using my Claude subscription instead of paying for API tokens?

**Technically possible, but not recommended** — especially if you're running this for clients or as a business.

**Why subscription doesn't work well for always-on bots:**

- Subscription requires browser-based OAuth login. On a headless server, there's no browser — sessions expire and need manual re-authentication.
- Even the Max plan has rate limits that can throttle your bot during heavy use.
- Running automated bots commercially on a subscription may violate Anthropic's Terms of Service.
- Managing auth sessions across multiple machines or clients becomes an ops nightmare.

**The API approach is simpler and often cheaper:**

| | Subscription | API (Sonnet) |
|---|---|---|
| **Cost** | $20-100/mo fixed | ~$5-20/mo for typical bot usage |
| **Auth** | Browser OAuth (fragile on servers) | API key (set and forget) |
| **Rate limits** | Plan-based throttling | Pay for what you use |
| **Headless servers** | Requires workarounds | Works natively |
| **Multi-client** | One subscription per person | One API key per client, clean isolation |

For a bot handling 50-100 messages per day, API costs typically run **$5-20/month** — comparable to or cheaper than a subscription.

---

### What about running macOS or Windows VMs to use a subscription?

This comes up when people want to avoid API costs by running a full desktop OS with a logged-in Claude subscription.

**macOS VMs:**
- Apple's license only allows macOS VMs on Apple hardware.
- Options: Mac Mini colocation (MacStadium ~$50/mo), AWS EC2 Mac instances.
- You still need to manage OAuth sessions and re-authenticate when they expire.

**Windows VMs:**
- Can run anywhere, Claude Code works on Windows.
- Needs a desktop environment kept alive for OAuth.
- Clunky and fragile compared to a simple API key on a Linux VPS.

**Bottom line:** The VM + subscription approach costs more and creates more problems than a $5/mo VPS + API key. The only scenario where it makes sense is if you're already running the bot on your personal desktop and want it on while your machine is awake — which is exactly what local mode does.

---

### I want to offer this as a service to clients (e.g., "CEO Operating System for SMBs"). What's the best architecture?

Use the **VPS + API key** approach. For each client:

1. Provision a VPS (~$5/mo per client)
2. Set up an Anthropic API key (their own or yours)
3. Deploy gobot with their profile, agents, and integrations
4. API cost: ~$10-20/mo per client depending on usage

Your margin is the difference between what you charge and the ~$15-25/mo infrastructure cost per client. This is clean, scalable, and doesn't require any hacks with subscriptions or VMs.

---

### What's the difference between local mode, VPS mode, and hybrid mode?

| Mode | How it works | Cost | Best for |
|------|-------------|------|----------|
| **Local** | Runs on your desktop with Claude Code CLI | Free with subscription | Personal use, testing |
| **VPS** | Runs on a cloud server with API key | ~$5/mo VPS + API tokens | 24/7 reliability |
| **Hybrid** | VPS always on, forwards to local when your machine is awake | VPS + subscription | Saving on API costs |

**Hybrid** gives you the best of both worlds: your local machine handles messages for free when it's awake, and the VPS takes over with API tokens when it's not.

---

## Setup Issues

### Bun says "command not found" after installing

Bun installs to `~/.bun/bin/` which may not be in your shell's PATH. Restart your terminal, or run:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

Add those lines to your `~/.zshrc` (macOS) or `~/.bashrc` (Linux) to make it permanent.

---

### Supabase keys look different from the docs

Supabase recently renamed their API keys:

- **"anon public key"** is now called **"Publishable key"** and may start with `sb_publishable_` instead of `eyJ`
- **"service_role secret key"** is now called **"Secret key"** and may start with `sb_secret_` instead of `eyJ`

Both formats work. Paste whatever your Supabase dashboard shows. If Claude Code questions the format, tell it Supabase updated their key naming and it's correct.

---

### Claude Code keeps asking for permission during setup

This is normal. Claude Code asks before running shell commands or editing files. Select **"Allow for this session"** to approve all similar actions during the setup process.

---

### macOS shows "Software from Jared Sumner can run in the background"

This popup appears when launchd services start. Jared Sumner is the creator of the Bun runtime, which powers the bot. Click **Allow** to let the services run. You can manage this later in System Settings > General > Login Items.

---

### Claude says it's hitting sandbox restrictions on Supabase calls

This happens when the Claude subprocess runs without full permissions. The bot needs `--dangerously-skip-permissions` in `src/lib/claude.ts` to allow outbound network calls and tool access in non-interactive mode. This was fixed in commit `e43d96a` — make sure you have the latest version.

---

## More Help

- [Architecture Deep Dive](./architecture.md)
- [Troubleshooting Guide](./troubleshooting.md)
- [Autonomee Community](https://skool.com/autonomee)
