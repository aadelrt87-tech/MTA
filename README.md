# MTA (tîşk)

Maintenance and operations PWA, in Arabic and English, on Asia/Baghdad time.

## Current development phase

**Frontend-only prototype.** This phase validates how the app works for its users, not a production system.

Current focus:

- UI/UX and navigation
- workflows and form behaviour
- responsive behaviour on phones (320–430 px) and larger screens
- Arabic / English (RTL / LTR)
- Generator Management
- Fuel Tank Management
- business-rule simulation (generator runtime plausibility, service status, fuel accounting)

## Login

Login is **Prototype Login for UX testing only. It is not real authentication.**

Any non-empty username and passcode opens the app. Nothing is verified, and the passcode is not stored or sent anywhere. It exists to test the Login → Overview → Logout journey. Every prototype user gets the Admin UI role, so every screen can be reached. It does not protect the public GitHub Pages site.

## Backend

**There is currently no application backend.**

Apps Script is deprecated and no longer used by the app. The app makes no requests to Apps Script, Google Sheets or Google Drive.

## Persistence

- **Generator and Fuel:** the generator catalog and runs, and fuel tanks, readings and movements, are kept in this browser's local storage, for workflow testing only. They are not shared between devices, and clearing the site's data removes them.
- **Older forms (Tasks, Purchase Requests, Attendance):** they validate the form and simulate the workflow ("Recorded for this prototype."), but nothing is durably persisted. Selected photos stay in the page until the form clears; nothing is uploaded.

## Future architecture (planned, not implemented)

- **Supabase Auth**: real sign-in, replacing Prototype Login
- **PostgreSQL**: durable records
- **Row Level Security (RLS)**: authoritative roles and permissions
- **RPC / transactions**: server-side validation and writes for Generator and Fuel
- **Supabase Storage**: photos and attachments
- **Cloudflare**, later: production edge and security controls

## Files

- `index.html`: the whole app (HTML, CSS and JavaScript)
- `sw.js`, `manifest.webmanifest`, `icons/`, `fonts/`: PWA support
- `DEVELOPMENT.md`: developer rules and the roadmap

## تشغيل GitHub Pages
من Settings → Pages اختر:
- Source: Deploy from a branch
- Branch: main
- Folder: / (root)
ثم Save.

الرابط المتوقع بعد نجاح النشر: https://aadelrt87-tech.github.io/MTA/
