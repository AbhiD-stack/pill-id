# Pill ID: how to run it

Everything here is free. Commands are for **PowerShell** on the Windows PC.

## The three pieces

| Piece | Where it runs | Address |
|---|---|---|
| **The app** (screens) | Vercel | **https://med-recognition-app.vercel.app/v3** |
| **The server** (pill model) | Your PC, `start_backend.bat` | `http://127.0.0.1:8000` on the PC |
| **The tunnel** (gives the server a public link) | Your PC, Tailscale Funnel | **https://ad-win.tail4ace25.ts.net** |

The app on Vercel sends every scan to the tunnel link, and the tunnel passes it
to the server on your PC. **The PC must be on, with the server running, for
scans and searches to work.**

## Everyday use

1. **The PC is on and logged in.** The startup shortcut opens the black server
   window by itself. Wait about a minute, until it says
   `Application startup complete.` Keep that window open.
2. **Open the app** on any phone or computer:
   https://med-recognition-app.vercel.app/v3. On a phone, use **Add to Home
   Screen**.

**Quick check:** open https://ad-win.tail4ace25.ts.net/api/health. It should
say `"status":"ok"`. (The plain address without `/api/health` always says
"Not Found". That's normal.)

## After the PC was turned off or restarted

1. Turn it on and **log in**. The server window should open by itself.
   - If it doesn't, double-click `start_backend.bat` in
     `C:\Users\kvd_\OneDrive\Documents\GitHub\pill-id`.
2. Wait for `Application startup complete.`
3. Check https://ad-win.tail4ace25.ts.net/api/health. If it doesn't load, run:
   ```
   tailscale funnel --bg 8000
   ```

Keep the PC from sleeping: **Settings → System → Power → Sleep when plugged
in: Never**. Set **Windows Update → Active hours** so updates don't restart it
while people are using the app.

## After changing the code

- **Changed something in `backend/`** (the server):
  ```
  cd C:\Users\kvd_\OneDrive\Documents\GitHub\pill-id
  git pull
  ```
  Then close the black server window and double-click the shortcut again.
- **Changed something in `frontend/`** (the app): push it to GitHub and Vercel
  rebuilds by itself. Wait until the deployment says **Ready** in Vercel, then
  refresh the app.

The current code is on the branch **`claude/lucid-pasteur-bjbe2w`**, and Vercel
builds the live app from it. `main` is older. To make `main` current, open a
pull request from that branch into `main` on GitHub and merge it. Then, in
Vercel, go to **Settings → Environments → Production → Branch** and set it to
`main`.

## Vercel settings (only if they get lost)

- **Root Directory:** `frontend`
- **Environment variable:** `NEXT_PUBLIC_API_URL` = `https://ad-win.tail4ace25.ts.net`
  (no slash at the end; tick Production, Preview and Development). After
  changing it, **Redeploy**.

## Running it on your PC without Vercel (for testing)

Two PowerShell windows:
```
cd C:\Users\kvd_\OneDrive\Documents\GitHub\pill-id
.\start_backend.bat
```
```
cd C:\Users\kvd_\OneDrive\Documents\GitHub\pill-id\frontend
npm.cmd run dev
```
Then open http://localhost:3000/v3. Use `npm.cmd`, not `npm`; PowerShell
blocks `npm`.

## When something goes wrong

| What you see | What to do |
|---|---|
| "Can't reach the Pill ID server" | Check the `/api/health` link above. If it fails, the server or tunnel is off: see "After the PC was turned off". |
| Chrome asks to **"Access other devices on your local network"** | Click **Allow**. This only happens on the PC that runs the server. If you clicked Block: address bar icon → Site settings → Local network access → Allow, then reload. |
| "Model is still loading" | The server was just started. Wait a minute. |
| "Pill ID was just updated: close any other Pill ID tabs" | Close other Pill ID tabs and windows, including the home-screen app. |
| My meds is empty / medicines missing | You're probably on a different link (each Vercel link has its own saved data). Use https://med-recognition-app.vercel.app/v3. |
| "Too many scans in a minute" | Wait a minute. Each device gets 40 a minute. |
| Server window: `error while attempting to bind on address ... 8000` | Another copy is already running. Close all server windows. If it still happens, run `netstat -ano \| findstr :8000`, then `taskkill /PID <number> /F` with the number from the `LISTENING` line. |
| PowerShell: "running scripts is disabled" | Use `npm.cmd` instead of `npm`, and `backend\.venv\Scripts\python.exe` instead of activating the environment. |

## Where the data lives (and what to back up)

- **Each person's medicines, photos, schedule and scan history** are stored
  only in their own phone's browser. Nothing about them is on the server.
  Clearing the browser's site data, or using a different link or browser,
  starts empty. There is no account or cloud copy.
- **On your PC, not in GitHub. Keep a copy of the whole `pill-id` folder**
  (OneDrive already syncs it):
  - `contributions/`: pill photos people chose to share
  - `feedback/`: scan photos from "this is my pill" / "none of these" answers
  - the model and catalog files the server loads (the server window prints
    where it loads them from)

## Numbers for doctors

The My Pills test (V3 model, real phone photos, front + back):

- Right medicine listed first: 97.6% (91.9% with a look-alike pill in the
  household)
- Someone else's pill confirmed as the patient's: 0.025% (about 1 in 4,000);
  caught as "not one of your medicines": 64.1%
- Patient's own pill wrongly called "not yours": 1.0%

Caveat to state: the test photos (ePillID) were also used to train V3, so
these numbers are optimistic. The safety settings are in
`frontend/src/lib/myPills.ts`. To rerun the test:
```
cd C:\Users\kvd_\OneDrive\Documents\GitHub\pill-id\backend
.venv\Scripts\python.exe scripts\eval_my_pills.py
```
Add `--photos <folder>` to test on your own photos: one sub-folder per pill.

## Free-tier limits

- **Vercel (Hobby):** free for personal, non-commercial use.
- **Tailscale (Personal):** free, includes Funnel.
- **The server:** your own PC, with no graphics card. A scan takes a few
  seconds, and several people scanning at once wait in line, but searches
  stay fast.
