# Oracle VM Backend (Free Tier)

Deploy the SanChase game server on Oracle Cloud Always Free, with Cloudflare Pages for the frontend.

## Architecture

- Frontend: Cloudflare Pages (HTTPS)
- Backend: Oracle VM + Cloudflare Tunnel (WSS, no open inbound ports required)

## Step 2A — Create Oracle VM

1. Create account: https://www.oracle.com/cloud/free/
2. In Oracle Console: **Compute → Instances → Create instance**
3. Name: `sanchase-api`
4. Image: **Ubuntu 22.04**
5. Shape: **Always Free eligible** (Ampere A1 or AMD Micro)
6. Add SSH key (generate one if needed)
7. Create instance and copy public IP

## Step 2B — Open SSH + optional direct port

In **Networking → Virtual Cloud Networks → your VCN → Security List**:

- Allow TCP `22` from your IP (SSH)
- Optional direct test port TCP `8787` from `0.0.0.0/0`

## Step 2C — Install server on VM

SSH in:

```bash
ssh ubuntu@<VM_PUBLIC_IP>
```

Then:

```bash
git clone https://github.com/Tonione/SanChase.git
cd SanChase
bash scripts/oracle/setup-vm.sh
curl http://127.0.0.1:8787/health
```

Expected:

```json
{"ok":true,"rooms":0}
```

## Step 2D — Secure public URL with Cloudflare Tunnel (recommended)

On VM:

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login
cloudflared tunnel create sanchase-api
cloudflared tunnel route dns sanchase-api api.yourdomain.com
```

Create `/home/ubuntu/.cloudflared/config.yml`:

```yaml
tunnel: sanchase-api
credentials-file: /home/ubuntu/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: api.yourdomain.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run as service:

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

Your backend websocket URL becomes:

`wss://api.yourdomain.com/ws`

## Step 3 — Frontend config

Set `apps/web/static/config.js`:

```js
window.__SANCHASE_CONFIG__ = {
  wsUrl: "wss://api.yourdomain.com/ws"
};
```

Deploy frontend on Cloudflare Pages (build: `npm ci && npm run build:web`, output: `dist/web`).

## Smoke test

1. Open frontend URL on two phones
2. Create/join same room
3. Verify location updates, mission hold, arrest, debrief marker
