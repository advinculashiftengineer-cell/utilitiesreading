# Aurelia Utility Tracker — Netlify version

Stores readings and budgets **online** (Netlify Blobs), so every phone, tablet and
laptop that signs in sees the same data. The password is checked on the server.

```
public/index.html              the dashboard
netlify/functions/data.mjs     the storage + login API  (/api/data)
netlify.toml                   tells Netlify where things are
package.json                   pulls in @netlify/blobs
```

## Deploy (about 10 minutes)

### Option A — GitHub (recommended)
1. Create a **private** GitHub repository and upload everything in this folder
   (keep the folder structure as-is).
2. In Netlify: **Add new project → Import an existing project → GitHub**, pick the repo.
   Leave the build settings alone (`netlify.toml` already sets them).
3. **Before the first deploy finishes**, open **Project configuration → Environment variables**
   and add:
   - Key: `APP_PASSWORD`
   - Value: the password you want to use
4. Deploy (or **Deploys → Trigger deploy** if you added the variable afterwards).

### Option B — Netlify CLI
```
npm install -g netlify-cli
netlify login
netlify init                                  # create/link the site
netlify env:set APP_PASSWORD "your-password"
netlify deploy --prod
```

> Drag-and-drop (Netlify Drop) is fine for plain HTML, but this project has a serverless
> function with an npm dependency, so use Git or the CLI to be sure the function is built.

## Check it works
1. Open your `*.netlify.app` address — you should see the lock screen.
2. Enter the password, add a reading.
3. Open the same address on your phone (or another browser), sign in, and the reading is there.

If the lock screen says it can't reach the storage service, the function didn't deploy:
check **Netlify → Functions** for `data`, then redeploy.
If it says the server isn't set up, `APP_PASSWORD` is missing.

## Good to know
- **Change the password:** edit `APP_PASSWORD` in Netlify, redeploy. Everyone is signed out.
- **Sync:** each device refreshes every 30 seconds and whenever you return to the tab.
- **Staying signed in:** the "Remember me" box keeps a device signed in for 30 days;
  otherwise it lasts until the tab closes (max 1 day).
- **Old data on a device:** the first time you sign in on a device that has readings saved from
  the earlier version, it offers to copy them online. Copying twice never creates duplicates.
- **Backups:** Netlify stores the data, but nothing exports it automatically.
- The page tells search engines not to index it.
