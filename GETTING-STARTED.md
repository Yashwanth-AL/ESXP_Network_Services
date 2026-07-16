# Getting started — ESXP Network Services

A simple, step-by-step guide to installing and running the DHCP dashboard on a
Linux server. No prior Kea or Linux-admin knowledge needed.

> Already comfortable with the details? The full technical reference is in
> [README.md](README.md).

---

## What you need

- A **Linux server** (Debian/Ubuntu, RHEL/Fedora/Alma/Rocky, or openSUSE) with
  **systemd** — a normal modern Linux install.
- **`sudo`/root** access on that server.
- Internet access on the server the first time (to download Kea and Python).

You do **not** need to install Kea yourself — the setup does it for you.

---

## 1. Install it (first time)

On the server, run these three commands:

```bash
git clone https://github.com/Yashwanth-AL/ESXP_Network_Services.git
cd ESXP_Network_Services
sudo ./run.sh
```

That's it. `run.sh` installs Kea and the dashboard, wires everything together,
and starts it as a background service. When it finishes it prints something
like:

```
Dashboard : http://192.168.1.10:8080/
Login     : admin / the default password 'admin' -- change it on first login
```

Open that URL in a browser, sign in with **admin / admin**, and you'll be asked
to set a new password right away.

---

## 2. Choose which network port DHCP listens on

By default the DHCP server listens on **all** network ports. To pin it to a
specific one (for example `eno1`):

1. Go to **DHCP → Configuration**.
2. In the **Listen interfaces** card at the top, untick **All interfaces** and
   tick the port(s) you want (the list is read from the server, so you'll see
   your real port names like `eno1`, `eth0`, `ens18`).
3. Click **Save listen interfaces**.

You'll get a confirmation toast that says where the change was saved on disk,
e.g. *"Now listening on: eno1 — saved to /etc/kea/kea-dhcp4.conf"*.

IPv4 and IPv6 each have their own selection — switch tabs to set both.

> If the server doesn't start serving on a newly picked port, restart it once
> from **DHCP → Settings** (the **Restart** button on the DHCPv4/v6 card).

---

## 3. Add a subnet (and confirm it saved)

1. **DHCP → Configuration → + New subnet**.
2. Fill in the subnet (e.g. `192.168.10.0/24`), the address pool, gateway, and
   DNS servers. Times can be entered in minutes/hours/days — no need to convert
   to seconds.
3. Click **Verify** to dry-run it against Kea, then **Create subnet**.

When it saves, the toast tells you the exact file it was written to, e.g.
*"Subnet created: 192.168.10.0/24 — saved to /etc/kea/kea-dhcp4.conf"*. That
message is your confirmation the change reached disk and will survive a
restart — not just that it was applied in memory.

You can double-check any time under **DHCP → Settings → operation history**,
which lists every save with a timestamp and success/failure.

---

## 4. Get the latest version later

When there are updates on GitHub, run the **same command** — it notices the
existing install and updates instead of reinstalling:

```bash
sudo ./run.sh
```

(That pulls the latest code, redeploys, and restarts the dashboard. Your subnets
and settings are left untouched. If an update fails partway, it automatically
rolls back to the version you were running.)

---

## If something isn't working

- **A save says it couldn't be written to disk, or subnets disappear after a
  refresh** → run:
  ```bash
  sudo ./install/repair-kea.sh
  ```
  This fixes the two most common Kea issues (letting Kea save its config, and
  turning on the lease commands the **Active Leases** page needs). It's safe to
  run more than once and won't touch your subnets.

- **The Active Leases page is empty or errors** → same fix as above
  (`sudo ./install/repair-kea.sh`).

- **Check the services are running:**
  ```bash
  systemctl status esxp-dashboard
  systemctl status kea-dhcp4-server kea-dhcp6-server kea-ctrl-agent
  ```

- **See the dashboard's own log:**
  ```bash
  journalctl -u esxp-dashboard -e
  ```

---

## Removing it

```bash
sudo ./install/uninstall.sh            # remove the dashboard (keep your data)
sudo ./install/uninstall.sh --purge    # also remove the database and settings
```

Kea itself is left installed.
