# 99 Privacy Breaches Preview

Lead-magnet microsite for new DPOs. Use the tabs to access the interactive preview,
project documentation, and deployment/editing instructions.


1\. Preview2\. Documentation3\. Deploy & Edit Guide

99 Privacy Breaches to Beware Of — Free Sample Chapters \| DPEX Network

📋 CourseReady to become a certified DPO? **DPO Course – Hands-on (Malaysia)** · 13–15 Apr 2026, KLDPO Course KL · 13–15 AprRM 5,250 · HRD Corp Claimable [Enroll →](https://www.dpexnetwork.org/courses/data-protection-officer-course-hands-on-my)

![Book Cover Icon](https://images-na.ssl-images-amazon.com/images/P/9814794643.01._SCLZZZZZZZ_.jpg)

99 Privacy Breaches

Overview

About the Book

Areas to beware of

Governance & Asset MgmtCollection of Personal DataUsage of Personal DataData Accuracy & IntegrityPhysical & Env SecuritySecurity, Storage & DisposalDisclosure of Personal DataNew Areas & Tech Concerns

[Purchase the Book](https://www.amazon.sg/Privacy-Breaches-Beware-Protection-Experiences/dp/9814794643)

![Book Cover Icon](https://images-na.ssl-images-amazon.com/images/P/9814794643.01._SCLZZZZZZZ_.jpg)

99 Privacy Breaches

Overview

About the Book

Areas to beware of

Governance & Asset MgmtCollection of Personal DataUsage of Personal DataData Accuracy & IntegrityPhysical & Env SecuritySecurity, Storage & DisposalDisclosure of Personal DataNew Areas & Tech Concerns

[Purchase the Book](https://www.amazon.sg/Privacy-Breaches-Beware-Protection-Experiences/dp/9814794643)

[Data Protection Excellence Network Resource](https://dpexnetwork.org/)

DPO


Select an Area


# Operational Compliance Hub

Select an area from the sidebar to explore real-world privacy breach cases, actionable DPO learnings, and accompanying video lessons.


![Book Cover](https://images-na.ssl-images-amazon.com/images/P/9814794643.01._SCLZZZZZZZ_.jpg)

[Get it on Amazon](https://www.amazon.sg/Privacy-Breaches-Beware-Protection-Experiences/dp/9814794643)

About the Book


# 99 Privacy Breaches to Beware Of

Practical Data Protection Tips from Real-Life Experiences

By Kevin Shepherdson, William Hioe & Lyn Boxall

Today, an increasing number of jurisdictions require notification of data breaches to relevant supervisory authorities. The details of the laws differ widely, but the mistakes that lead to breaches are the same wherever they happen - for example, you had a 'bad day' and clicked the wrong button, giving an employee's ex-wife access to his health data, or you accidentally sent the data of one of your students to 1,900 parents.

The authors have gathered hundreds of hints in 99 chapters that will help you develop all the procedures you need to avoid data breaches without having to read all the legislation.

99

Chapters

8

Modules

5+

Jurisdictions

Free

Preview

### What Industry Leaders Say

"This book is exceptional on a number of levels. Well-written and logically constructed, it draws upon the experience of the authors to provide a roadmap for addressing day-to-day privacy issues at a pragmatic level."

Gordon Hughes

Partner, Davies Collison Cave, Melbourne

"Finally, a book focusing on operational practice, rather than the law, has been written. I wholeheartedly endorse this comprehensive and practical effort and hope it will become the standard bible for data protection practices."

Dr Toh See Kiat

Veteran Lawyer in Data Protection & Former MP of Singapore

"Much has been written previously for compliance officers, privacy professionals and lawyers... But this handbook is for the layperson - easy to read and practical. It fills in many gaps and answers many questions about how to comply."

Prof. Abu Bakar Munir

Author of Data Protection Law in Asia

"This book achieves a rare feat: making personal data protection practical, understandable and actionable. It is a valuable resource for marketers at all levels."

Lisa Watson

Chairman, Direct Marketing Association of Singapore

### Want to dive deeper?

Get exclusive access to more case studies, full checklists, and practical guides on operational compliance directly to your inbox.

Get Free DPO Checklist

## Documentation

This project is a static GitHub Pages site summarising selected chapters from
**99 Privacy Breaches to Beware Of**, aimed at new Data Protection Officers (DPOs).


### What this page is for

- Lead magnet for DPO services and training.
- Operationally focused, not legal-jargon heavy.
- Scenario format: context, DPO learnings, checklist, optional short video.

### Core content model

- `aboutBookData`: book intro, testimonial and lead-capture section.
- `bookData`: all sections and chapter cards shown in the sidebar and content pane.
- Per chapter fields: `num`, `title`, `context`, `learnings`, `checklists`, and optional `videoTitle`/`videoUrl`.

### Current content architecture

- `index.html`: this 3-tab landing shell.
- `app.html`: the original interactive training preview page.
- `README.md`: project-level notes and mapping rationale.

### Soft gate — how chapter access works

A **soft gate** means visitors can read a free sample before they're asked for their email.
The first chapter is unlocked for everyone. After that, a sign-up form appears inline — right in the flow of reading, not as a pop-up or a wall before the page loads.


**Why this converts better than a hard paywall:** If you block the page entirely until someone signs up, most people leave without ever seeing the content.
A soft gate lets them get value first — they read one chapter, get curious, and _want_ more. By the time they hit the form, they're already invested. This is the same approach used by top newsletter and content marketing pages.


- The number of free chapters is currently set to **1**. You can increase this in `app.html` by changing the `FREE_CHAPTERS` value.
- Once someone submits the form, all chapters unlock instantly — no page reload needed. The unlock is remembered in their browser, so it stays unlocked on return visits.
- Using a third-party form like Growthworks? See the Deploy tab — you just need to set a redirect URL after form submission. No other code changes required.

Video embeds in the app now use `youtube-nocookie.com` links for cleaner embed behavior on GitHub Pages.


## Deploy & Edit Guide

### Deploy Preview-Only Page (No Docs/Deploy Tabs)

- Source repo: `Altoh5/99-Breaches-Preview`
- Deploy **only**`app.html` as the campaign landing page.
- Do not publish `index.html` if you do not want Documentation/Deploy tabs visible.
- Rename `app.html` to your platform landing filename if needed (for example `index.html` inside the campaign folder).
- Target path example: `/privacy/99-breaches/`.

\# 1) Pull latest repo version
git clone https://github.com/Altoh5/99-Breaches-Preview.git

\# 2) Use preview app only
app.html

\# 3) Publish to target URL (example)
https://www.yourcompany.com/privacy/99-breaches/

### WordPress deployment

- Create a blank page template (no heavy theme wrappers) for the campaign URL.
- Deploy content from `app.html` only (not the tab-shell `index.html`).
- Upload/host `app.html` and map the campaign URL directly to it, or paste its body content into the page template.
- If your security plugin strips scripts, whitelist required script tags or enqueue scripts via theme/plugin.

### GrowthWorks deployment

- Create a new landing page in GrowthWorks and switch to custom HTML mode.
- Paste content from `app.html` only.
- Do not use the tab-shell `index.html` unless you explicitly want docs/deploy tabs visible.
- Add GrowthWorks form/embed script to replace placeholder lead capture handlers in `app.html`.

### Unlocking chapters after Growthworks lead capture

When a visitor submits your Growthworks form, you need to redirect them back to the preview page
with `?unlocked=1` so the chapters unlock automatically. Here's how:


1. In Growthworks, open your form's **Success / Thank You** settings.
2. Set the redirect URL to:

`
                 https://altoh5.github.io/99-Breaches-Preview/?unlocked=1
`
3. The page will automatically detect the parameter on load, set `localStorage` to unlock all chapters,
    then strip `?unlocked=1` from the URL — so sharing the link with others won't auto-unlock them.

4. Optionally, replace or hide the inline gate form in `app.html`: find the `handleGateSubmit`
    function and swap the `<form>` block with a button linking to your Growthworks form URL.


**Test end-to-end:** Submit a test lead in Growthworks and confirm you are redirected to the preview page with all chapters unlocked. Then clear `localStorage` (DevTools → Application → Local Storage → delete `99b_unlocked`) and repeat to verify the gate reappears for new visitors.


### Unlocking chapters after GrowthWorks lead capture

The chapter gate unlocks automatically when the visitor lands on the page with `?unlocked=1` in the URL.
Set your GrowthWorks form's **Success / Thank You redirect URL** to:


https://altoh5.github.io/99-Breaches-Preview/?unlocked=1

The page will automatically:

- Detect the `?unlocked=1` parameter on load
- Set `localStorage` to unlock all chapters for that visitor
- Strip the parameter from the URL (so sharing the page won't auto-unlock others)

**No code changes needed.** Just set the redirect URL in GrowthWorks. The unlock mechanism is already built into `app.html`.


### Corporate deployment checklist

- Confirm external CDNs are allowed: Tailwind CDN, Lucide CDN, Google Fonts, YouTube embeds.
- If CSP blocks inline scripts/styles, move them to approved static JS/CSS files.
- Set campaign metadata in page title, OG tags, and analytics tracking IDs.
- Run mobile QA after publish (menu, tabs, videos, lead form).

### How to update chapter content

Open `app.html` and edit the `bookData` object.

{
num: 101,
title: "New chapter title",
hasVideo: true,
videoTitle: "Related video: ...",
videoUrl: "https://www.youtube-nocookie.com/embed/VIDEO\_ID",
context: "Real-world scenario",
learnings: "DPO takeaway",
infographic: "",
checklists: \[\
"Action 1",\
"Action 2"\
\]
}

### How to add or change lead capture

In `app.html`, search for `leadCaptureHtml`.
There are CTA blocks in both the About view and Chapter view.


- Update headline, body copy, and button label in the HTML template string.
- Replace `onsubmit="event.preventDefault(); ..."` with your corporate form handler or embed script.
- Typical options: webhook, CRM form POST, API route, or marketing automation form embed.
- Ensure consent text and privacy notice link match your corporate policy.

### How to update video links safely

- Prefer exact title-matched videos from your playlist.
- If only close match exists, keep label as `Related video:`.
- Use embed format: `https://www.youtube-nocookie.com/embed/VIDEO_ID`.
- Set `hasVideo: false` and null out URL/title if no good match exists.

### Marketing Handoff One-Pager

**Campaign:** 99 Privacy Breaches Micro Landing Page

**Primary Goal:** Lead capture (new DPO / compliance audience)

**Deployment File for Marketing:**`app.html` only


### Who does what

- Marketing Ops: deploy page, connect form endpoint, add tracking tags.
- Content Team: update chapter text, CTA copy, and video mappings.
- Web Team: ensure scripts/CSP/iframe policy allow full rendering.

### Inputs needed before launch

- Final landing URL slug (WordPress/GrowthWorks destination).
- Lead destination (CRM/list/webhook) + required form fields.
- Analytics IDs (GA4, Meta Pixel, LinkedIn Insight, etc.).
- Privacy notice URL and consent language.

### Pre-launch checklist

- Desktop + mobile rendering validated (tabs, menu, sidebar navigation).
- All video embeds load and play from allowed domains.
- Lead form submit path tested end-to-end into CRM.
- SEO/OG metadata populated for campaign sharing.

### Post-launch checks (first 24 hours)

- Confirm page views and conversions in analytics dashboard.
- Confirm first test leads are correctly captured and routed.
- Monitor mobile bounce and fix any fold/layout issues quickly.

### How to add analytics and tracking tags

Open `app.html` and paste your tracking snippets inside the `<head>` tag, just before `</head>`.

**GA4 (Google Analytics 4)**

<!\-\- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
window.dataLayer = window.dataLayer \|\| \[\];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-XXXXXXXXXX'); // replace with your Measurement ID
</script>

**Meta Pixel (Facebook/Instagram ads)**

<!\-\- Meta Pixel -->
<script>
!function(f,b,e,v,n,t,s){...}(window,document,'script',
'https://connect.facebook.net/en\_US/fbevents.js');
fbq('init', 'YOUR\_PIXEL\_ID'); // replace with your Pixel ID
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=YOUR\_PIXEL\_ID&ev=PageView&noscript=1"/></noscript>

**LinkedIn Insight Tag**

<!\-\- LinkedIn Insight Tag -->
<script type="text/javascript">
\_linkedin\_partner\_id = "XXXXXXX"; // replace with your Partner ID
window.\_linkedin\_data\_partner\_ids = window.\_linkedin\_data\_partner\_ids \|\| \[\];
window.\_linkedin\_data\_partner\_ids.push(\_linkedin\_partner\_id);
</script>
<script src="https://snap.licdn.com/li.lms-analytics/insight.min.js" async></script>

**Where to get your IDs:** GA4 → Google Analytics → Admin → Data Streams → your stream → Measurement ID (starts with G-). Meta Pixel → Meta Events Manager → your Pixel → Settings → Pixel ID. LinkedIn → Campaign Manager → Measurement → Insight Tag → Partner ID.


### Continuous Enhancement

Use the **SMART board in Startinfinity** to track ongoing improvements to this resource.
Look up existing assets for **99 Privacy Breaches to Beware Of** — videos, write-ups, infographics, and book samples — and link them here or embed them into relevant chapters.
Update the SMART board whenever new content is added so the team can reuse these assets across classes and markets in the region.