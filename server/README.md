# sendnew-server

API + WebSocket hub connecting your CRM website to the Mac mini fleet.
See `../docs/ARCHITECTURE.md` and `../docs/API.md` for the full picture.

## Deploying to Railway

1. Create a new Railway project, point it at this repo, set the root directory
   to `server/`.
2. Add a Postgres plugin — Railway sets `DATABASE_URL` for you.
3. Set env vars from `.env.example` (`JWT_SECRET`, `ADMIN_SECRET`).
4. Build/start commands:
   - Build: `npm install && npx prisma generate && npx prisma migrate deploy`
   - Start: `npm start`
5. After first deploy, provision your first company + device:

```bash
curl -X POST https://<your-app>.up.railway.app/admin/companies \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"name":"Acme Co","webhookUrl":"https://your-crm.example.com/webhooks/sendnew"}'

curl -X POST https://<your-app>.up.railway.app/admin/devices \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"username":"macmini-01","password":"a-strong-per-device-password","label":"Rack A #1"}'

curl -X POST https://<your-app>.up.railway.app/admin/devices/<deviceId>/assign \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"companyId":"<companyId>"}'
```

The `username`/`password` from the device-provisioning call is what you type
into the agent app's login screen on that specific Mac mini (or bake into its
DMG build — see `../dmg-build/README.md`).

## Local dev

```bash
cp .env.example .env   # fill in a local Postgres URL
npm install
npx prisma migrate dev
npm run dev
```
