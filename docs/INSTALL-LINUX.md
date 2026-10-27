# Installing Voxshift on a Linux server

This guide takes you from a blank Linux server to a working Voxshift with a proper HTTPS certificate. Follow the steps in order.
The more detailed material (every installer option, backup encryption, restore, how it works) is in
[INSTALL-LINUX-REFERENCE.md](INSTALL-LINUX-REFERENCE.md). You do not need it for a normal install.

Every command here is run on the server, in a terminal. Lines that start with `#` are notes, not commands.

## Before you start

You need:

- A Linux server on x86-64. Debian, Ubuntu, RHEL, Rocky, Alma, CentOS and Fedora all work.
  (A 64-bit Raspberry Pi 4 or 5 can run an experimental ARM64 build: see "Raspberry Pi and other 64-bit ARM" in [INSTALL-LINUX-REFERENCE.md](INSTALL-LINUX-REFERENCE.md#raspberry-pi-and-other-64-bit-arm-experimental).)
- 4 GB of memory, 2 CPUs and 10 GB of free disk space.
- A DNS name for Voxshift, for example `voice.contoso.com`, pointing at the server.
- Ports 80 and 443 open from the people who will use Voxshift to the server.
- Internet access from the server (to `ghcr.io`, where the program is downloaded).
- An account that can use `sudo`.

Decide on the address now. People will type it in their browser, and the certificate has to be made for exactly that name.

## Step 1. Download the installer

```bash
curl -fsSL https://github.com/gauntlec/teams-voice-migration-factory/releases/latest/download/install.sh -o install.sh
```

To check the download before you run it, see "Installer checks" in [INSTALL-LINUX-REFERENCE.md](INSTALL-LINUX-REFERENCE.md#installer-checks-and-pinning-a-release).

## Step 2. Get a certificate for your address

The certificate is what makes the padlock appear in the browser. Pick the one line that describes you:

- **A.** The name works on the internet (anyone can look it up) and the server can be reached from the internet.
  Nothing to prepare. Go to Step 3 and use **Install A**. The certificate is free and renews itself.
- **B.** The name only works inside your network and you have a **Microsoft internal certificate authority** (AD CS). Follow **2.1 to 2.4** and **2.5 (Microsoft CA)**.
- **C.** You buy certificates from an **external certificate authority** (DigiCert, Sectigo, GoDaddy and so on). Follow **2.1 to 2.4** and **2.5 (external CA)**.
- **D.** This is only a test. Go to Step 3 and use **Install D**. Browsers will show a warning.
- **E.** You have no certificate authority and do not want to buy a certificate. Voxshift makes a **self-signed certificate** on the server for you.
  Go to Step 3 and use **Install E**, then do "Trusting a self-signed certificate" (below) so browsers accept it.
  A self-signed certificate lasts one year by default, and each computer has to be told to trust the new one after every renewal.
  If you have a few computers and want to trust something once, use D and trust Voxshift's own root certificate instead.

A public authority will not issue a certificate for a name that only works inside your network (such as `voice.contoso.local`).
For those names use your Microsoft CA (B).

### 2.1 Make a working folder

Do this on the Voxshift server. The private key is made here and never needs to leave it.

```bash
mkdir ~/voxshift-cert
chmod 700 ~/voxshift-cert
cd ~/voxshift-cert
```

### 2.2 Make the certificate request

Replace `voice.contoso.com` with your address (the name only, no `https://`). Then paste all of this into the terminal:

```bash
NAME=voice.contoso.com
cat > server.cnf <<EOF
[req]
distinguished_name = dn
req_extensions = san
prompt = no
[dn]
CN = $NAME
[san]
subjectAltName = DNS:$NAME
EOF
openssl req -new -newkey rsa:2048 -nodes -keyout server.key -out server.csr -config server.cnf
```

This creates two files:

- `server.key` is the private key. Keep it secret. Never email it, and never send it to the certificate authority.
- `server.csr` is the request. This is what you give to the certificate authority.

Some authorities ask for a company name and country. If yours does, add two lines under `[dn]` before you run the last command:
`O = Contoso Ltd` and `C = US`.

### 2.3 Check the request

```bash
openssl req -in server.csr -noout -text | grep -E "Subject:|DNS:"
```

You should see your name twice: once after `CN =` and once after `DNS:`. If not, repeat 2.2.

### 2.4 Show the request so you can copy it

```bash
cat server.csr
```

It starts with `-----BEGIN CERTIFICATE REQUEST-----`. Copy everything from that line to the `-----END` line. You will paste it in the next step.

### 2.5 Send the request to the authority

#### Microsoft CA (path B)

Ask your CA administrator which certificate template to use. It is usually called **Web Server**. The finished certificate must contain your name
in the "Subject Alternative Name" field. If it does not, browsers will refuse it, and the administrator has to change the template or the CA setting.

Pick the way that suits you.

**Way 1: the CA's web page (if your CA has it).**

1. On a computer inside your network, open `https://<your-ca-server>/certsrv` in a browser.
2. Click **Request a certificate**, then **advanced certificate request**.
3. Click **Submit a certificate request by using a base-64-encoded CMC or PKCS #10 file**.
4. Paste the request from 2.4 into the large box.
5. Under **Certificate Template** choose **Web Server** (or the template your administrator named). Click **Submit**.
6. Choose **Base 64 encoded**, then click **Download certificate**. Save the file (it is called `certnew.cer`).
7. Go back to the CA's home page and click **Download a CA certificate, certificate chain, or CRL**.
8. Choose **Base 64**, then click **Download CA certificate chain**. Save the file (it is called `certnew.p7b`; rename it `chain.p7b`).

**Way 2: from a Windows computer on your domain.**

Copy `server.csr` to the Windows computer, then open Command Prompt and run these two commands. Use your CA's name (written `ServerName\CAName`) and the template name your administrator gave you
(the template's name has no spaces, for example `WebServer`):

```
certreq -submit -config "CAserver\CAName" -attrib "CertificateTemplate:WebServer" server.csr certnew.cer
certutil -config "CAserver\CAName" -ca.chain chain.p7b
```

If the CA needs an administrator to approve the request, `certreq` prints a request ID and stops. After approval run
`certreq -retrieve -config "CAserver\CAName" <ID> certnew.cer`.

**Way 3: give the file to your CA administrator.** Send them `server.csr` (only the request, never the key) and ask for two things:
the certificate for your server as a Base 64 (PEM) file, and the CA's certificate chain (root and issuing CA).

Copy the files back to the Voxshift server, into `~/voxshift-cert`. For example, from a Windows or Mac computer:

```bash
scp certnew.cer chain.p7b youruser@voice.contoso.com:voxshift-cert/
```

Then go to **2.6**.

#### External authority (path C)

1. Sign in to your certificate provider and start a new certificate order for your address.
2. When it asks for the request (CSR), paste the text you copied in 2.4. Choose the server type **Other**, **nginx** or **Apache** if it asks.
3. Complete the checks the provider asks for. This is usually a DNS record, an email to an address on your domain, or a small file on a website.
4. When the certificate is ready, download these two things:
   - your certificate (often called `your_domain.crt`);
   - the intermediate or CA bundle (often called `ca-bundle.crt` or `intermediate.crt`).
5. Copy both files to the Voxshift server, into `~/voxshift-cert`. For example:

```bash
scp voice_contoso_com.crt ca-bundle.crt youruser@voice.contoso.com:voxshift-cert/
```

Then go to **2.6**.

### 2.6 Put the files in the right shape

Voxshift needs two files: `fullchain.pem` (your certificate followed by the authority's chain) and `server.key` (the key from 2.2).
Do the part that matches what you were given. All commands run in `~/voxshift-cert` on the server.

**You have a certificate file `certnew.cer` and a chain file `chain.p7b` (Microsoft CA).**

```bash
# the certificate: if this prints a line starting with -----BEGIN it is ready, else see the note below
head -1 certnew.cer
cp certnew.cer server.crt

# the chain: turn the .p7b into plain text
openssl pkcs7 -in chain.p7b -print_certs | awk '/BEGIN CERT/,/END CERT/' > chain.pem
# if that says "unable to load", use this instead:
# openssl pkcs7 -inform DER -in chain.p7b -print_certs | awk '/BEGIN CERT/,/END CERT/' > chain.pem

cat server.crt chain.pem > fullchain.pem
```

If `head -1 certnew.cer` does not show `-----BEGIN CERTIFICATE-----`, the file is in the other format. Convert it with
`openssl x509 -inform DER -in certnew.cer -out server.crt` instead of the `cp` line.

**You have a certificate file and a CA bundle (external authority).**

```bash
cat voice_contoso_com.crt ca-bundle.crt > fullchain.pem
```

Use your own file names. Your certificate must come first.

**You were given a `.pfx` file** (some administrators and providers make the key for you, which is less safe, but it works).
Replace `cert.pfx` with your file name. Each command asks for the password of the `.pfx` file.

```bash
openssl pkcs12 -in cert.pfx -nocerts -nodes | openssl pkey -out server.key
openssl pkcs12 -in cert.pfx -clcerts -nokeys | openssl x509 -out server.crt
openssl pkcs12 -in cert.pfx -cacerts -nokeys -chain | awk '/BEGIN CERT/,/END CERT/' > chain.pem
cat server.crt chain.pem > fullchain.pem
```

### 2.7 Check the files

Check that the certificate is for your name and has not expired:

```bash
openssl x509 -in fullchain.pem -noout -subject -issuer -dates
openssl x509 -in fullchain.pem -noout -text | grep -A1 "Alternative Name"
```

Your name must appear after `DNS:`. Check the dates, and put a reminder in your calendar for a month before `notAfter`.

Check that the key belongs to the certificate. These two commands must print the **same** line:

```bash
openssl x509 -in fullchain.pem -noout -pubkey | openssl sha256
openssl pkey -in server.key -pubout | openssl sha256
```

If they differ, the certificate was made from a different request. Start again at 2.2, or find the right key.

Check that the file holds more than your own certificate. This should print 2 or more (it prints 1 if the chain is missing):

```bash
grep -c "BEGIN CERTIFICATE" fullchain.pem
```

Your two files are ready: `~/voxshift-cert/fullchain.pem` and `~/voxshift-cert/server.key`.

## Step 3. Install

Use the line for your path. Change the address and the email to yours. The email becomes the first administrator's sign-in.

**Install A (public name, free certificate):**

```bash
sudo bash install.sh --base-url https://voice.contoso.com --admin-email admin@contoso.com
```

**Install B or C (your own certificate):**

```bash
sudo bash install.sh --base-url https://voice.contoso.com --admin-email admin@contoso.com \
  --tls custom --cert ~/voxshift-cert/fullchain.pem --key ~/voxshift-cert/server.key
```

**Install D (test, Voxshift's own certificate):**

```bash
sudo bash install.sh --base-url https://voice.contoso.com --admin-email admin@contoso.com --tls internal
```

**Install E (a self-signed certificate made on the server):**

```bash
sudo bash install.sh --base-url https://voice.contoso.com --admin-email admin@contoso.com --tls selfsigned
```

This makes the certificate for exactly the address you typed (a name or an IP address) and installs it. It is valid for 365 days. To choose another length
add `--selfsigned-days 730` (30 to 825 days are allowed).

The installer asks a few questions (answer them, or press Enter for the suggestion). It installs Docker if it is missing, downloads Voxshift and starts it.
When it finishes it prints the address, the sign-in name and a generated password. Write the password down. It is also in `/opt/voxshift/.env`.

If the installer stops, it says why in plain words. Fix that and run the same command again.

## Step 4. Sign in and check

1. Open your address in a browser. You should see the padlock and no warning. (With Install D or E you will see a warning until you have done
   "Trusting a self-signed certificate" below.)
2. Sign in with the email and password from the installer.
3. Set up your authenticator app when asked.
4. Open **Administration > Platform settings** and check that the web address is right.

If the browser shows a warning, see "If something goes wrong" below.

## Step 5. Set up the essentials

- **Email.** In **Administration > Platform settings > Email**, choose how Voxshift sends mail, then click **Send test**. No email is sent until this is done.
- **Backups.** Run `sudo voxshift backup`, then copy the folder it names to another computer. Do this regularly. A backup holds the private key and passwords, so keep it safe.
  To encrypt backups, see [INSTALL-LINUX-REFERENCE.md](INSTALL-LINUX-REFERENCE.md#encrypting-backups-optional).
- **Updates.** Run `sudo voxshift update` when a new version is out, or switch on automatic updates with `sudo voxshift auto-update on`.

## Optional: device status (Uptime Kuma)

Voxshift can show whether each site's phones, paging units and gateways are answering (**Monitoring > Devices**). The checking is done
by **Uptime Kuma**, a small free monitoring program that runs next to Voxshift on this server. Add it when you want this; Voxshift works
without it.

Add it during the install by putting `--with-kuma --kuma-web` on the install command (Step 3), or to a running installation any time:

```bash
sudo voxshift kuma on --web
```

It starts Kuma and prints what to do next. In short:

1. (Optional) Kuma's own screen is at **`https://<your Voxshift address>:8443`** with `--web` (the same certificate as Voxshift; use another port with `--web 9443`). Voxshift makes the administrator, so there is no account to create; the password is kept inside Voxshift.
   Open that port in the server's firewall **for the networks your staff use only**: anyone who can reach it sees Kuma's sign-in page. (`--open-firewall` at install time opens it too.)
   Prefer not to open a port? Leave out `--web`: Kuma is then only on the server itself, reached from your own computer through an SSH tunnel
   (`ssh -L 3001:127.0.0.1:3001 you@the-server`, then `http://localhost:3001`). Port 3001 in use? `sudo voxshift kuma on --port 3005`.
2. In Voxshift open **Monitoring > Devices** and press **Set up automatically**. Voxshift creates Kuma's administrator account itself (you do not need to), sets up the checking and the status page, and keeps them up to date.
3. Press **Add a device** for each phone, paging unit or gateway: its site, a name, the kind of device, how to check it (ping, or a TCP port) and its IP address. Within seconds it shows on the tab as up or down.

You only need to open Kuma's own screen (step 1) if you want to see its detail. Kuma already running with an administrator of your own? Enter that sign-in when Voxshift asks for it, or use **I run Kuma myself** and add the monitors in Kuma, tagged **site** and **device** on a status page with **Show Tags** on.

`sudo voxshift kuma status` shows whether it is running and where its screen is; `sudo voxshift kuma on --no-web` closes the web port again; `sudo voxshift kuma off` removes it (its data stays unless you add `--delete-data`).
Backups include Kuma's data and settings once it is on.

## Trusting a self-signed certificate (Install D or E)

A browser only accepts a certificate that its computer trusts. Your own authority's certificates are already trusted on computers joined to your domain.
A self-signed certificate (Install E) and Voxshift's own certificate (Install D) are not, so you tell each computer to trust it once.

On the server, save the public certificate (it holds no secrets) into your home folder:

```bash
sudo voxshift certificate export
```

It writes `voxshift-certificate.crt` in the folder you are in. For Install E that is the server's certificate. For Install D it is Voxshift's root certificate.
Copy it to each computer, for example from that computer:

```bash
scp youruser@voice.contoso.com:voxshift-certificate.crt .
```

Then install it on each computer:

**Windows.** Right-click the file, choose **Install Certificate**, choose **Local Machine**, then **Place all certificates in the following store**,
click **Browse**, pick **Trusted Root Certification Authorities**, and finish. Or, in an administrator PowerShell:

```
Import-Certificate -FilePath .\voxshift-certificate.crt -CertStoreLocation Cert:\LocalMachine\Root
```

For many computers, deploy the file with Group Policy: **Computer Configuration > Policies > Windows Settings > Security Settings > Public Key Policies >
Trusted Root Certification Authorities > Import**.

**Mac.** Double-click the file (it opens Keychain Access). Add it to the **System** keychain. Then double-click the certificate in the list, open **Trust**,
and set **When using this certificate** to **Always Trust**.

**Linux (Debian, Ubuntu):**

```bash
sudo cp voxshift-certificate.crt /usr/local/share/ca-certificates/voxshift.crt
sudo update-ca-certificates
```

**Linux (RHEL, Rocky, Alma, Fedora):**

```bash
sudo cp voxshift-certificate.crt /etc/pki/ca-trust/source/anchors/voxshift.crt
sudo update-ca-trust
```

**Firefox** keeps its own list. Open **Settings > Privacy & Security > Certificates > View Certificates > Authorities > Import**, choose the file and tick
**Trust this CA to identify websites**. (Or switch on `security.enterprise_roots.enabled` in `about:config` so Firefox uses the computer's list.)

Close and reopen the browser, then open Voxshift. The padlock should appear with no warning.

Voxshift tells browsers to use only https for a year (HSTS), and a browser then refuses to let people click past a certificate warning. So trust the certificate
before people first visit, or install with `--hsts-max-age 600` for the first few days.

## Renewing or replacing the certificate

Do this before the old certificate expires. If it expires, people cannot open Voxshift (the browser remembers the site must use a valid certificate).

**Public name with a free certificate (Install A):** nothing to do. It renews itself.

**Your own certificate (Install B or C):**

1. Repeat steps 2.2 to 2.7 in the same folder (`cd ~/voxshift-cert`). The new files replace the old ones. To keep your current private key and only ask for a new certificate,
   use this in 2.2 instead of the last command: `openssl req -new -key server.key -out server.csr -config server.cnf`.
2. Install them. Voxshift checks them first (the key must match, the certificate must be for your address and not expired), swaps them in, restarts the front door and
   puts the old files back by itself if anything goes wrong:

```bash
sudo voxshift certificate install --cert ~/voxshift-cert/fullchain.pem --key ~/voxshift-cert/server.key
```

3. Check the result:

```bash
sudo voxshift certificate status
```

   It shows the address, who issued the certificate and when it runs out. Then open the address in a browser.

**A self-signed certificate (Install E):** make a new one and trust it again on the computers (see "Trusting a self-signed certificate"):

```bash
sudo voxshift certificate selfsigned
sudo voxshift certificate export
```

### Moving an existing install to another certificate

If Voxshift was installed with Install A or D and you now want your own certificate, first get the two files (Step 2), then use the same command:

```bash
sudo voxshift certificate install --cert ~/voxshift-cert/fullchain.pem --key ~/voxshift-cert/server.key
```

To switch to a self-signed certificate instead: `sudo voxshift certificate selfsigned`.

An installation made before this command existed does not have it yet. Run `sudo voxshift self-update` first (it refreshes only the `voxshift` command).

## Everyday commands

```bash
sudo voxshift status          # is everything running?
sudo voxshift update          # back up, then install the newest version
sudo voxshift backup          # make a backup
sudo voxshift certificate status   # which certificate is in use and when it runs out
sudo voxshift kuma status     # device status (Uptime Kuma): on or off, and its state
sudo voxshift logs            # watch the logs (Ctrl+C to stop)
sudo voxshift restart         # restart everything (a short outage)
sudo voxshift reset-admin     # set a new password for the first administrator
```

Everything starts again by itself after the server reboots.

## If something goes wrong

**The browser says the connection is not private.**
- Own certificate: the browser computer does not trust your authority yet. Computers joined to your domain normally trust a Microsoft CA already.
  If yours do not, ask your administrator to deploy the CA's root certificate to them (Group Policy).
- Install D or E: the browser does not trust Voxshift's own or the self-signed certificate yet. This is expected until you do "Trusting a self-signed certificate" above. For a service many people use, B or C is easier.
- It worked before and now shows a warning: the certificate may have run out. Run `sudo voxshift certificate status`. A self-signed certificate lasts 365 days unless you chose otherwise; make a new one with `sudo voxshift certificate selfsigned` and trust it again.
- The name in the browser must be exactly the name in the certificate. An IP address or a different name will give this warning.

**The installer says it cannot read the certificate or key.** Check the file names and that you ran the commands in `~/voxshift-cert`.

**`voxshift certificate install` refuses the files.** It says why in plain words: the key does not match the certificate (it was made from another request), the certificate has
expired, or it is for a different name. Nothing is changed when it refuses. Fix the file, or ask the authority for the right certificate.

**Voxshift will not start after changing the certificate.** Check that the two files match (the two `sha256` lines in 2.7 must be identical) and that `fullchain.pem`
starts with your own certificate, not the CA's. Then run `sudo voxshift logs caddy` to see the exact message.

**The certificate request keeps getting refused.** Ask the CA administrator or your provider to check that the name in the request is the one you typed in Step 1.

**Public name (Install A) will not get a certificate.** The name must already point at this server and ports 80 and 443 must be reachable from the internet.
Fix the DNS record or the firewall, then run `sudo voxshift restart`.

## Removing an installation

This deletes Voxshift **and all of its data**. Make a backup first if you may need anything.

```bash
curl -fsSL https://github.com/gauntlec/teams-voice-migration-factory/releases/latest/download/uninstall.sh -o uninstall.sh
sudo bash uninstall.sh --dry-run     # shows what would go, changes nothing
sudo bash uninstall.sh               # asks you to type DELETE
```

## More detail

[INSTALL-LINUX-REFERENCE.md](INSTALL-LINUX-REFERENCE.md) covers the installer options, how the address is secured, automatic updates, backups,
encrypted backups, restoring, and what has and has not been tested. To report a security problem, see [SECURITY.md](../SECURITY.md) in the repository root.
