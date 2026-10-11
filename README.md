# jobhunter

A command-line job hunter. It reads your CV, checks remote job boards, lets an AI score every new job against your profile, and keeps everything in a Google Sheet in your own Drive, so you never see the same job twice.

```
$ jobhunter hunt
✔ Remotive: 18 jobs
✔ Remote OK: 99 jobs
✔ We Work Remotely: 89 jobs
✔ Checked your sheet
✔ Scored 35 jobs

Best matches:
 92  Senior Full-Stack Engineer · Acme (Remotive)
     Strong match: 6 years of React and Node.js, fully remote, salary above your minimum.
 85  Product Engineer · Globex (We Work Remotely)
     Good fit for your TypeScript and Rails experience; EU timezones only, which suits you.
 …

✔ 206 jobs · 0 already in your sheet · 206 new → 171 ignored by your filters · 12 To apply · 23 Skipped
```

- **Your CV is the source of truth.** Jobhunter works out your roles, seniority and stack from it and turns them into a short candidate profile the AI uses when scoring jobs.
- **Cheap filters first, the AI second.** Code drops jobs that clearly don't fit (wrong role, too old, wrong employment type or work mode, salary below your minimum, companies you avoid). Only the rest goes to the AI, which gives each a score from 0 to 100 and a short note.
- **Everything lands in a Google Sheet** with status tabs, colours and dropdowns, ready for you to track your applications.
- **Your data stays yours.** Your keys and profile live on your machine. Jobhunter can only see the files it created in your Drive.

> Jobhunter works with **Claude (Anthropic)** today. **More AI providers are coming soon**, starting with Google Gemini.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Setting up Google access](#setting-up-google-access)
- [Commands](#commands)
  - [`jobhunter init`](#jobhunter-init)
  - [`jobhunter hunt`](#jobhunter-hunt)
  - [Coming soon](#coming-soon)
- [Your tracking sheet](#your-tracking-sheet)
- [Common tasks](#common-tasks)
- [Where your data lives](#where-your-data-lives)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- **Node.js 22.12 or newer.** Check with `node --version`. Get it from [nodejs.org](https://nodejs.org/).
- **An Anthropic API key**, from the [Anthropic Console](https://console.anthropic.com/settings/keys). Usage is billed by Anthropic to your account. A typical hunt with a small model like Claude Haiku costs a few cents.
- **A Google account** for the tracking sheet, plus a free Google Cloud project to sign in with ([step-by-step guide below](#setting-up-google-access)).
- **Your CV** as PDF, DOCX, Markdown or plain text.

## Install

```sh
npm install -g jobhunter
```

Then run `jobhunter --help` to check it's installed.

## Quick start

1. **Create your Google OAuth client** by following [Setting up Google access](#setting-up-google-access). Do this first, because `init` asks for the file it gives you. It takes about 10 minutes, once.
2. **Run the setup:**
   ```sh
   jobhunter init
   ```
   It walks you through the AI key, your CV, your preferences, Google sign-in and creating the tracking sheet. When it says "You're all set. 🎉 Happy hunting! 🏹", you're done.
3. **Go hunting:**
   ```sh
   jobhunter hunt
   ```
   New jobs appear in your sheet. Open the **To apply** tab to see the best matches.
4. **Run `jobhunter hunt` again whenever you like**, for example once a day. Jobs already in your sheet are skipped, so you only ever see new ones.

## Setting up Google access

Jobhunter writes to a Google Sheet in your Drive. To do that, Google needs to know which app is asking. For now, every user creates their own small, free **OAuth client** in Google Cloud and gives the downloaded file to Jobhunter. Nothing gets deployed, and there's no billing.

> **Coming in a future version:** Jobhunter will ship with its own Google sign-in, so you won't need to create a Google Cloud project at all. Using your own OAuth client will stay available as an option for anyone who prefers it.

### 1. Create a Google Cloud project

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and sign in with the Google account that should own the tracking sheet.
2. Click the project picker at the top → **New project**. Name it anything, for example `jobhunter`, then **Create**.
3. Make sure the new project is selected in the project picker.

Google's guide: [Create a Google Cloud project](https://developers.google.com/workspace/guides/create-project).

### 2. Enable the Sheets and Drive APIs

With your project selected, open each link and click **Enable**:

- [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)

Google's guide: [Enable Google Workspace APIs](https://developers.google.com/workspace/guides/enable-apis).

### 3. Configure the consent screen

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) (under **APIs & Services → OAuth consent screen**) and click **Get started**.
2. **App information:** any app name (for example `jobhunter`), and your email as the support email.
3. **Audience:** choose **External**.
4. **Contact information:** your email. Accept the policy and click **Create**.
5. Go to **Audience** → **Test users** → **Add users** and add your own Google address. While the app is in "Testing" mode, only test users can sign in.

Google's guide: [Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent).

> **Sign-ins expire after 7 days in "Testing" mode.** Google does this for every app in Testing, so after a week `hunt` will ask you to sign in again. To avoid it, open **Audience** and click **Publish app**. Jobhunter only asks for access to the files it creates itself (the non-sensitive `drive.file` scope), so publishing doesn't need a Google review for your own use.

### 4. Create the OAuth client and download it

1. Go to [Clients](https://console.cloud.google.com/auth/clients) → **Create client**.
2. **Application type:** **Desktop app**. Name it anything, then click **Create**.
3. Click **Download JSON** and save the file (named like `client_secret_….json`) somewhere you can find it.

Google's guide: [Create OAuth client ID credentials for a desktop app](https://developers.google.com/workspace/guides/create-credentials#desktop-app).

### 5. Give the file to Jobhunter

Run `jobhunter init`. When it gets to Google, paste the path of the downloaded file. Jobhunter copies it into its own config folder, so you can delete the download afterwards. Your browser then opens Google's sign-in page. Choose your account and allow access.

You may see **"Google hasn't verified this app"**. That's expected: it's your own app. Click **Continue**.

### What Jobhunter can access

Jobhunter asks for three permissions:

- `openid` and `email`: shows which account you're connected as.
- `drive.file`: lets it see and edit **only the files Jobhunter created**, meaning the `Jobhunter` folder and the tracking sheet inside it. It can't see anything else in your Drive.

You can remove access at any time in your [Google Account permissions](https://myaccount.google.com/permissions).

## Commands

### `jobhunter init`

Sets everything up. Run it once to start. Run it again any time to change one part of your setup.

**On first run** it goes through every step:

1. **AI provider, key and model.** Choose Anthropic (Claude), paste your API key, and pick a model from the list your key can use. Jobhunter checks that the key and model actually work before going on. Claude Haiku is the cheapest; Sonnet scores more carefully.
2. **CV.** Give the path to your CV (PDF, DOCX, MD or TXT). PDF and Word files are converted to Markdown by the AI. You see a short summary (name, roles) and can accept it, edit it in your editor, or try again.
3. **Preferences.** A few questions the CV can't answer:
   - work mode (remote, hybrid, onsite)
   - countries you can legally work from, and your timezone
   - cities and relocation, for hybrid or onsite work
   - whether you need visa sponsorship
   - employment type
   - minimum salary (optional)
   - industries and companies to avoid (optional)
4. **Candidate profile.** The AI writes a short profile of you from your CV and preferences. This is what it reads when scoring jobs. You can accept it, edit it in your editor, or have it written again.
5. **Google Sheets.** Give the path to your OAuth client file ([how to get one](#setting-up-google-access)) and sign in with Google in your browser.
6. **Tracking sheet.** Jobhunter creates the sheet in a `Jobhunter` folder in your Drive and prints its link.

**When you're already set up**, `init` asks what you'd like to change:

| Choice                                      | Use it when you want to…                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Everything                                  | start over from step 1                                                                          |
| AI provider, key or model                   | switch to another model, or replace your API key (press Enter to keep the saved one)            |
| CV                                          | import an updated CV; your preferences and candidate profile are updated after it               |
| Preferences and candidate profile           | change what you're looking for, or rewrite the profile the AI scores you by                     |
| Google Sheets connection and tracking sheet | sign in again or with another account, use a different OAuth client file, or create a new sheet |
| Nothing, exit                               | leave everything as it is                                                                       |

Any step can be skipped and finished later by running `jobhunter init` again. Pressing Ctrl+C cancels without saving the step you're in.

### `jobhunter hunt`

Finds new jobs and adds them to your sheet. Each run goes like this:

1. **Fetch** the job boards: [Remotive](https://remotive.com), [Remote OK](https://remoteok.com) and [We Work Remotely](https://weworkremotely.com). A board checked in the last 6 hours is skipped, to go easy on it. If one board is down, the others still run.
2. **Skip jobs already in your sheet**, in any tab, including jobs you added by hand with a link, plus the same job listed on two boards.
3. **Filter in code.** A job is ignored if:
   - its title doesn't match your roles or main technologies (any software engineer or developer title still goes through, so the AI can judge it)
   - it was posted more than 30 days ago
   - its employment type or work mode isn't one you chose
   - its salary, in your currency, is below your minimum
   - its company or industry is on your avoid list

   Ignored jobs go to the **Ignored** tab with the reason. When a job doesn't say something (no salary, say), it isn't ignored for that.

4. **Score with the AI.** The remaining jobs, newest first, are sent to the AI together with your candidate profile, CV and preferences. Each gets a score from 0 to 100 and a short note: why it fits, the main gaps, and anything to watch for, like timezone or location limits. Location is judged here rather than in code, because "EU only" or "EMEA" needs judgement.
5. **Write to your sheet.** Jobs scoring at or above your cut-off (50 by default) go to **To apply**; the rest go to **Skipped**, with the note explaining why.
6. **Print a summary:** how many jobs were found, known, ignored and scored, your 10 best matches with their notes, and how many AI tokens the run used.

**Options**

| Option                | What it does                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `-f, --force`         | Check every board, even ones checked in the last 6 hours.                                       |
| `--dry-run`           | Show the results without writing anything to your sheet. Doesn't need Google to be connected.   |
| `--no-ai`             | Skip the AI: every job that passes the filters goes to To apply, without a score or note. Free. |
| `--max-ai-jobs <n>`   | Score at most this many jobs per run (default 100). The rest wait for the next run.             |
| `--since <days>`      | Ignore jobs posted more than this many days ago (default 30).                                   |
| `--min-score <score>` | The score needed for To apply, for this run only (0–100).                                       |

Examples:

```sh
jobhunter hunt                    # the usual
jobhunter hunt --dry-run          # look before writing anything
jobhunter hunt --since 7          # only jobs from the last week
jobhunter hunt --force            # check the boards again right now
jobhunter hunt --min-score 70     # stricter: only strong matches go to To apply
```

### Coming soon

These commands are listed in `jobhunter --help` but aren't ready yet:

| Command                      | What it will do                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `jobhunter discover`         | Let the AI search the web for more job boards and feeds that match your profile.               |
| `jobhunter sync`             | Apply the "Change status" picks from the status tabs to the Applications tab.                  |
| `jobhunter map <source>`     | Have the AI work out how to read a new job feed (JSON or XML), so you can add your own boards. |
| `jobhunter convert <source>` | Convert a job feed to Jobhunter's format with its saved mapping.                               |

Also planned: more AI providers (Google Gemini first), using an existing spreadsheet as your tracking sheet, and Jobhunter's own Google sign-in.

## Your tracking sheet

`init` creates a spreadsheet called **Jobhunter** in a `Jobhunter` folder in your Drive.

| Tab                                                                                      | What's in it                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Applications**                                                                         | Every job you're tracking, one per row: company, role, applied date, where it was found, status, last update, link, the AI's note, two columns for your own notes, and the match score. Rows are coloured by status. |
| **To apply**, **Applied**, **Interview & Offer**, **Declined**, **Ghosted**, **Skipped** | Read-only views of Applications filtered by status. They update by themselves.                                                                                                                                       |
| **Ignored**                                                                              | Jobs the filters dropped, with the reason. They stay here so they aren't checked again.                                                                                                                              |

**To track an application**, change its **Status** in the Applications tab with the dropdown: To apply → Applied → Interview → Offer, or Declined, Ghosted, Withdrawn or Skipped. Fill in **Applied** and **Last update** as you go. The row colour and the view tabs follow the status.

A few hidden columns (Key, Source, Found) and a hidden `_meta` tab are how Jobhunter recognises jobs it has already seen. Please don't rename or delete them. You can add your own columns after the last one.

## Common tasks

**Change the AI model or API key.** Run `jobhunter init` → **AI provider, key or model**. Press Enter at the key prompt to keep your saved key, then pick a model. The new model is used from the next `hunt` on.

**Update your CV.** Run `jobhunter init` → **CV**. Your preferences and candidate profile are updated after it.

**Change what you're looking for.** Run `jobhunter init` → **Preferences and candidate profile**.

**Fine-tune how jobs are scored.** Your candidate profile is a plain Markdown file (see [Where your data lives](#where-your-data-lives)). Edit it in any editor, for example to add "no agencies" or "I prefer product companies". The next `hunt` uses it.

**Change the To apply cut-off for good.** Use `--min-score` for a single run. To change the default of 50, add `"minScore": 70` (any number from 0 to 100) inside `"preferences"` in your `profile.json`.

**Sign in again, or switch Google accounts.** Run `jobhunter init` → **Google Sheets connection and tracking sheet** → **Sign in again**.

**Use a different OAuth client file.** Same menu → **Use a different credentials file**.

**Start with a fresh sheet.** Run `jobhunter init` → **Google Sheets connection and tracking sheet** → **Keep it** for the connection → **Create a new one** for the sheet. The old sheet stays in your Drive until you delete it. Because the new sheet is empty, the next `hunt` treats every listed job as new and scores it again. Add `--force` if the boards were checked in the last 6 hours.

**Have a job checked again.** Delete its row from Applications or Ignored. The next `hunt` (with `--force`, if the boards were checked recently) will treat it as new.

**Disconnect Google.** Remove Jobhunter's access in your [Google Account permissions](https://myaccount.google.com/permissions), and delete `google-token.json` (and `google-credentials.json` if you like) from the config folder.

**Uninstall.**

```sh
npm uninstall -g jobhunter
rm -rf ~/.config/jobhunter ~/.cache/jobhunter
```

Then remove Google access as above. Your tracking sheet stays in your Drive.

## Where your data lives

Everything is stored on your machine, in `~/.config/jobhunter` (or `$XDG_CONFIG_HOME/jobhunter`):

| File                               | What it holds                                                      |
| ---------------------------------- | ------------------------------------------------------------------ |
| `config.json`                      | AI provider, model and API key                                     |
| `google-credentials.json`          | your Google OAuth client (a copy of the file you downloaded)       |
| `google-token.json`                | your Google sign-in                                                |
| `profiles/default/profile.json`    | your preferences, facts from your CV, and your tracking sheet's ID |
| `profiles/default/cv.md`           | your CV as Markdown                                                |
| `profiles/default/instructions.md` | your candidate profile, the text the AI scores jobs by             |

Files holding keys or tokens are readable only by you (mode 600), and Jobhunter warns you if their permissions get looser. When each board was last checked is kept in `~/.cache/jobhunter/sources.json`. Deleting it just makes the next `hunt` check every board.

Set `JOBHUNTER_HOME` to keep everything in another folder instead (useful for testing).

## Privacy

- **Anthropic** receives your CV when it's converted (PDF and DOCX only) and when your profile is written. On each `hunt` it also receives your candidate profile, CV and preferences along with the jobs being scored. See [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- **Google** stores your tracking sheet in your Drive. Jobhunter can only reach the files it created.
- **Job boards** are fetched anonymously. Nothing about you is sent to them.
- Jobhunter itself has no server and collects nothing.

## Troubleshooting

**"Your Google sign-in has expired or was revoked."** Your app is probably still in "Testing" mode, where sign-ins last 7 days. Run `jobhunter init` → Google → **Sign in again**, and [publish the app](#3-configure-the-consent-screen) so it doesn't happen again.

**"Access blocked" or "has not completed the Google verification process" when signing in.** Add your Google address under **Audience → Test users** in [Google Auth Platform](https://console.cloud.google.com/auth/audience), or publish the app.

**"Google Sheets API has not been used in project … or it is disabled."** Enable both [Sheets](https://console.cloud.google.com/apis/library/sheets.googleapis.com) and [Drive](https://console.cloud.google.com/apis/library/drive.googleapis.com) for the project your OAuth client belongs to. Wait a minute, then try again.

**"Every source was checked recently."** Each board is checked at most once every 6 hours. Use `jobhunter hunt --force` to check now.

**"Before hunting, set up …"** Part of the setup is missing. Run `jobhunter init` and finish the step it names.

**The API key is rejected, or there's no credit.** Check your key and billing in the [Anthropic Console](https://console.anthropic.com/), then run `jobhunter init` → **AI provider, key or model**.

**Too many good jobs in Skipped, or too many poor ones in To apply.** Lower or raise the cut-off with `--min-score`, or edit your candidate profile (`instructions.md`) to say more clearly what you want and what you don't.

## Development

```sh
git clone <this repository>
cd jobhunter
npm install
npm run build        # bundle to dist/ with tsup
npm link             # make `jobhunter` available globally from this checkout
npm test             # vitest
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run format       # prettier
```

`npm run dev` rebuilds on every change. Tests never touch your real config: they use a temporary `JOBHUNTER_HOME` and mock every network call.

## License

[MIT](LICENSE) © 2026 Nikoloz Kavtaradze
