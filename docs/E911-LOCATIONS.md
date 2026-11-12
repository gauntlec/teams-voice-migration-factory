# Emergency locations (E911) - design and build plan (Phase C)

Status: **plan, awaiting approval**. Version 1.2, 11 November 2026.
1.1 (2 November): approach checked against Microsoft Learn, see [section 9](#9-checked-against-microsoft-learn).
1.2 (11 November): the feature request "E911 for Site Data, Design & Build, and Deployment" folded in (section 0): a
per-site switch, the site contact confirming the address, the emergency calling policy and its notifications
designed in Design & Build, and planned policies that can be given to users before they exist in Teams. Build
order revised (section 7); questions to settle first in [section 10](#10-questions-to-settle-first).

Phase C of the build and deployment automation plan (Phase A: call forwarding, delegates and pickup groups;
Phase B: call queues and auto attendants - both shipped). The first version of this plan (7 September 2026)
only gave resource accounts a location picker. This version re-checks it against today's code and Microsoft
Learn, and widens it: an emergency location can go on **every** number (required for Calling Plan numbers and Shared
Calling resource accounts), and **every** site that uses dynamic emergency calling (the usual answer for Direct
Routing) needs its network linked to places. Each chunk below is shippable on its own and ends with a deploy and a live check. See the
[build log](#build-log) for what has shipped.

## 0. What the feature request asks for (11 November 2026)

1. **A switch per site.** E911 is on automatically for US sites; any other site can have it switched on under
   Tenancy > Sites.
2. **Site Data** (the existing E911 tab grows):
   - a tick box, with who ticked it and when, for the site contact to confirm that the civic address is correct;
   - the notification requirements: notification only, or a conference (and whether muted), and the people who
     are notified.
3. **Design & Build** creates the emergency calling policy and its settings, the emergency location and the
   subnet data. Giving policies to users already exists.
4. **Deployment** carries out what Design & Build says.
5. **Planned policies**: a policy Design & Build means to create, not yet in Teams, can still be chosen for users.

How this plan takes them: 1, 2 and the notification part of 3 are new (chunk C0 and C2 below). The emergency
location and subnet data in 3 are what this plan already covered (C1, C2, C4); the addresses, places and subnets
are captured in Site Data, where the site contact confirms them, and Design & Build chooses and deploys them
(question 1 in section 10). 5 is a Design & Build change for every policy Voxshift designs, not only E911 (C2).

## 1. What Teams needs (checked on Microsoft Learn, 2 November 2026)

| Teams object | Cmdlet | What it holds | Who needs it |
|---|---|---|---|
| Emergency address (civic address) | `New-CsOnlineLisCivicAddress` | Street address of a building. `-CompanyName`, `-CountryOrRegion` (ISO 3166-1 alpha-2), **`-Latitude`/`-Longitude` are now mandatory** (except Australia and Japan), `-HouseNumber`, `-StreetName`, `-StreetSuffix`, `-City`, `-StateOrProvince`, `-PostalCode`, `-Description`, `-Elin`. Returns `CivicAddressId` and a `DefaultLocationId`. | Everyone |
| Place (location) | `New-CsOnlineLisLocation -CivicAddressId -Location [-Elin]` | A floor, wing or room inside an address. The address's default location is used when there is nothing finer. | Everyone |
| Number's emergency location | `Set-CsPhoneNumberAssignment -Identity -TelephoneNumber -NumberType -LocationId` when assigning, or `Set-CsPhoneNumberAssignment -TelephoneNumber -LocationId` to change only the location of a number already assigned. `-LocationId 'null'` removes it (Direct Routing and Operator Connect only). | Static address of a number. | **Required**: Calling Plan numbers (US and Canada: at assignment; elsewhere: already set when the number was acquired or ported), and the resource account number used by a **Shared Calling** policy, whatever its type. **Optional but useful**: Direct Routing and Operator Connect numbers, as the fallback when the client can't find a location; common area phones especially, whose static address is routed straight to the emergency centre. |
| LIS subnet / Wi-Fi access point / switch / port | `Set-CsOnlineLisSubnet -Subnet -LocationId`, `Set-CsOnlineLisWirelessAccessPoint -BSSID`, `Set-CsOnlineLisSwitch -ChassisID`, `Set-CsOnlineLisPort` | Maps the network the Teams client is on to a place, so the client knows where it is (dynamic emergency calling). Matched in the order Wi-Fi AP, switch/port, switch, subnet. The subnet must be the network ID (10.10.10.150/25 is 10.10.10.128). | Direct Routing sites (with an ERS provider or an ELIN gateway), and any site where people move between floors or buildings |
| Trusted IP address | `New-CsTenantTrustedIPAddress` | The site's public internet addresses. A client only asks for a dynamic location by subnet when it is on one of these. | Dynamic emergency calling |
| Network site | `New-CsTenantNetworkSite`, `New-CsTenantNetworkSubnet` | Gives a site its own emergency calling and emergency call routing policy and security-desk notification. | Optional; later chunk |
| Emergency calling policy | `New-`/`Set-CsTeamsEmergencyCallingPolicy`, `Grant-CsTeamsEmergencyCallingPolicy` (checked 11 November 2026) | The security desk notification: `-NotificationMode` (NotificationOnly, ConferenceMuted, ConferenceUnMuted), `-NotificationGroup` (users and groups by UPN or SMTP address, separated by ";": at most 10 addresses and 50 people in all), `-NotificationDialOutNumber` (a PSTN number dialled into the conference; it can't be unmuted), `-ExternalLocationLookupMode` (Enabled lets users set an address when working remotely), `-EnhancedEmergencyServiceDisclaimer` (up to 350 characters, shown in the Calls app), `-ExtendedNotifications` (different settings per emergency dial string, e.g. 911 and the 933 test number, made with `New-CsTeamsEmergencyCallingExtendedNotification`), `-Description`. | Everyone who wants the security desk told of an emergency call |
| Emergency call routing policy | `New-`/`Set-CsTeamsEmergencyCallRoutingPolicy`, `Grant-CsTeamsEmergencyCallRoutingPolicy` | The emergency numbers and the PSTN usage that routes them (`-EmergencyNumbers`, made with `New-CsTeamsEmergencyNumber -EmergencyDialString -EmergencyDialMask -OnlinePSTNUsage`; the PSTN usage must already exist), and `-AllowEnhancedEmergencyServices` for dynamic emergency calling. Direct Routing only. | Direct Routing (question 3 in section 10) |

Rules that shape the design:

- **An address must be validated before it can be given to a number or a network identifier.** Teams admin
  center validates an address automatically when it's found with the map search. One made in PowerShell comes
  back `ValidationStatus: NotValidated`, and the validation parameters on the cmdlet are for Microsoft's own
  use. So Voxshift can't count on validating the addresses it creates. See section 4.5 for how the plan handles
  this.
- **A validated address can't be edited.** To change one, delete it and create it again. `Set-CsOnlineLisCivicAddress`
  only changes addresses that are not validated, and only in some countries (the United States is one).
- An address, or a place, can only be removed when no user or number uses it. The default location goes only
  when its address is removed.
- An address, its users and its numbers must all be in the same country.
- A network identifier can only point at a place whose address has a latitude and longitude. Addresses more
  than a couple of years old can't be given to network identifiers: they must be created again.
- Calling Plan addresses need house number, street, city, postal code, latitude, longitude and company name,
  plus state or province in the US, Canada, Israel and Italy, and a company tax ID in several European countries.
  In Belgium, France, Germany, Ireland, the Netherlands and Spain the address must match the number's area code.
- Changes to network settings can take up to four hours to reach Teams clients.
- Not done by Voxshift (carrier or SBC side): the SBC's PIDF/LO setting (`Set-CsOnlinePSTNGateway -PidfloSupported`),
  the ERS provider contract, and ELIN records on the gateway. They become a checklist on the site and in the
  handover pack.

## 2. What Voxshift has today

- **Discovery** reads `Get-CsOnlineLisLocation` and `Get-CsOnlineLisCivicAddress` into `tenant_objects`
  (`emergency_location`, `civic_address`). It does not read LIS subnets, Wi-Fi access points, switches, ports,
  trusted IPs or network sites.
- **Site Data** has the site's primary address (`discovery_sites.address`, `latitude`, `longitude`), more
  addresses for a campus (`discovery_site_addresses`, migration 0076), and the **Network (E911)** tab
  (`discovery_network`: subnet, mask, scope internal/external, LAN/WLAN, VLAN). All addresses are free text, and
  nothing links a subnet to a place.
- **Design & Build**: resource accounts have a free-text "Emergency location ID (for shared calling)" field
  (`build_resource_accounts.location_id`), which the planner passes as `-LocationId`. Users and common area
  phones have no location at all, so a Calling Plan or Operator Connect user can't be given one.
- **Deployment**: rollback already says "the emergency location set with the number is not restored".
- **Policies**: Design & Build can give a user or common area phone an emergency calling policy and an emergency call
  routing policy (`POLICY_KINDS`), but only one Discovery has found in Teams: the pickers list `tenant_policies`,
  and the user's choice is stored as that row's id. Nothing designs an emergency calling policy, so there's no
  way to choose one that will be created by the deployment. Shared Calling policies are designed in Design & Build
  (`build_shared_calling_policies`), but the same picker rule applies to them.
- **Sites**: no E911 switch. The Network (E911) tab shows for every site.

## 3. Data model

Build on the addresses the site already has, rather than a separate list of addresses next to them.

**Addresses get structured fields** (migration on both `discovery_sites` and `discovery_site_addresses`):
`company_name`, `house_number`, `house_number_suffix`, `pre_directional`, `street_name`, `street_suffix`,
`post_directional`, `city`, `state_or_province`, `postal_code`, `country_or_region` (ISO alpha-2), `elin`,
`live_civic_address_id`, `live_default_location_id`. The existing free-text `address` stays: it's still what the
map pins and the handover shows. A "Split this address" button fills the structured fields from it (from the
map's geocoder result where we have it, otherwise left for the person to check). Latitude and longitude come from
the map pin the site already has.

**New table `discovery_locations`**: the places inside an address.

```sql
CREATE TABLE {{SCHEMA}}.discovery_locations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES {{SCHEMA}}.discovery_sites(id) ON DELETE CASCADE,
  address_id        uuid REFERENCES {{SCHEMA}}.discovery_site_addresses(id) ON DELETE CASCADE, -- null = the site's primary address
  name              text NOT NULL,          -- "Floor 2", "Warehouse", "Main lobby"
  elin              text,
  live_location_id  text,                    -- set when matched to, or created in, Teams
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

Every address also has an implicit **"Whole building"** place, which is Teams' default location for that
address; it needs no row.

**Links to a place** (all nullable `uuid` columns, with the meaning "this address's whole building" when an
address but no place is picked):

- `discovery_network.location_id`, `discovery_network.address_id`: where this subnet is.
- `build_users`, `build_caps`, `build_resource_accounts`: `emergency_address_id` + `emergency_location_id`,
  replacing the free-text `location_id`. Existing values: a value that is the id of a live emergency location in
  Discovery is mapped to it; anything else is cleared and listed on the site's change log so nothing disappears
  silently.
- New table `discovery_wireless_access_points` (BSSID, description, place) and, later, switches and ports, for
  sites that need finer matching than a subnet.

Each site gets a **default place** (the primary address, whole building), so a user doesn't need one picked by
hand unless they sit somewhere else.

**The site's E911 switch and the site contact's confirmation** (on `discovery_sites`, migration in C0):
`e911_enabled boolean` (null = automatic: on when the site's country is the US, off otherwise; true/false = set
on Tenancy > Sites), `e911_address_confirmed_by uuid`, `e911_address_confirmed_at timestamptz` and
`e911_address_confirmed_text text` (the address as it read when confirmed). Changing the address or any of its
structured fields clears the confirmation, and the site's change log says so, so a confirmation always matches
what's there now.

**Notification requirements** (Site Data, C0): `discovery_sites.e911_notification jsonb`: mode (notification
only, conference muted, conference unmuted, or none), the people (site users or typed addresses, at most 50 people
and 10 entries in all, as Teams allows), a dial-out number, and a free-text note. These are the requirement in
the customer's words; Design & Build turns them into the policy.

**New table `build_emergency_calling_policies`** (C2): `site_id`, `name` (default "E911-<site code>"),
`description`, `notification_mode`, `notification_group text[]`, `dial_out_number`, `external_location_lookup
boolean`, `disclaimer`, `extended_notifications jsonb` (per dial string: 911, 933), `discovery_sites` link, and
the usual timestamps; filled from the site's notification requirements with one click, then editable. Matched to
a live `TeamsEmergencyCallingPolicy` by name, like Shared Calling policies.

**Planned policies** (C2): a user's or common area phone's policy choice can name a policy Design & Build will
create, stored as `planned:<kind>:<build row id>` beside the existing tenant policy ids. Deployment creates the
policy before the grants that need it; once Discovery finds it in Teams, the choice is moved to the live policy's
id. The picker lists planned ones with "(planned)". It works for every policy Voxshift designs: emergency calling
policies first, Shared Calling policies with the same change.

## 4. Matching with Teams (the hard part)

The original plan called this "the trickiest reconciliation in the whole plan". The rules:

1. **Address**: a Site Data address matches a live civic address when country, postal code, house number and
   street name match, ignoring case, spaces and punctuation, and abbreviations (St/Street, Ave/Avenue, N/North).
   One match: it's linked (`live_civic_address_id`), shown as "In Teams" with its validation status. More than
   one: the engineer picks. None: "Will be created".
2. **Place**: within a linked address, a place matches a live location by name, ignoring case and spaces.
3. **Created by Voxshift**: the worker reads `CivicAddressId`, `DefaultLocationId` and `LocationId` from what
   the New- cmdlets return and writes them on the row straight away (as the audio import already does for
   `teams_audio_file_id`), so the steps after it in the same run can use them and a re-run doesn't create a
   second copy.
4. **Never edited behind someone's back**: Voxshift doesn't change or delete an address it didn't create. If the
   Site Data address differs from the linked live one, it's shown as a difference. Teams can't edit a validated
   address, so the choices are "Keep Teams' version" or (for an address Voxshift created that isn't validated
   yet, in a country Teams allows) "Update in Teams". Anything else is an engineer's job in Teams admin center.
5. **Validation is a gate, not a step Voxshift can do.** A place can only be used for a number or a network
   identifier once Discovery reads its address as `Validated`. Until then the rows that need it show "Waiting for
   the address to be validated in Teams admin center", with a link to it, and the deployment leaves those
   location steps out (the rest of the row still deploys). Two ways to get there, decided after the C3 test:
   - Voxshift creates the address in Teams, the engineer opens it in Teams admin center and validates it with
     the map search, and the next Discovery sync opens the gate.
   - Or the engineer creates the address in Teams admin center with the map search (validated straight away) and
     Voxshift only matches it (rule 1) and creates the places, links and number locations.

   The C3 test also checks whether an address Voxshift creates with a latitude and longitude comes back validated
   on its own in the US; if it does, the gate opens without anyone doing anything.

## 5. Screens

- **Tenancy > Sites**: an "E911" column and switch per site: "Automatic (on, US site)", "Automatic (off)", "On",
  "Off". Where it's off, Site Data hides the E911 tabs and Design & Build doesn't check E911 for the site.
- **Site Data > Network (E911)**, now **E911**: three parts.
  - **Address**: the address (structured, from C1) with **"I confirm this is the site's civic address"**, ticked by
    the site contact (or anyone who can edit the site), showing who confirmed it and when. Cleared if the address
    changes.
  - **Notifications**: tiles for "Notify only", "Conference them in, muted", "Conference them in, able to speak",
    "Don't notify"; the people to notify (picked from the site's users or typed, up to 50); an optional number to
    dial out to.
  - **Subnets**, as today, with the place column from C1.
- **Site Data > Emergency locations** (new tab, next to Network (E911)): each address with its structured fields,
  map pin and validation state, and its places under it. Customers and PMs can fill it in (it's site
  information); the "In Teams" column shows for engineers and Super Admins only.
- **Site Data > Network (E911)**: a "Place" column on each subnet. A new **Wi-Fi access points** list.
- **Design & Build > Emergency calling** (new tab, C2): the site's emergency calling policy, made from the site's
  notification requirements with one click and editable (mode, who is notified, dial-out number, remote
  address lookup, disclaimer, separate settings for 911 and 933). "In Teams" or "Will be created", and the
  differences when it's in Teams already. Users' and common area phones' emergency calling policy defaults to it.
- **Design & Build**: an "Emergency location" column on Users, Common area phones and Resource accounts (a
  dropdown of the site's places, defaulting to the site's default). Validation:
  - a Calling Plan number with no place, or a resource account in a Shared Calling policy with no place (error,
    blocks that row);
  - a common area phone with no place (warning);
  - a place whose address is missing a field its country needs (section 1), or is in a different country from the
    number (error);
  - a Direct Routing site with no internal subnets linked to places (warning: dynamic emergency calling won't
    give a location);
  - an address that's not validated in Teams (warning).
- **Deployment**: new "Emergency locations" section in the plan, before users. What-If shows each address and
  place to create, each subnet/access point to map, and each number getting a location.
- **Handover pack**: an Emergency calling section filled from all of the above, plus the SBC/ERS checklist.

## 6. Deployment order

0. `New-CsTeamsEmergencyCallingPolicy` (or `Set-` when it's in Teams and differs) for the site's policy, before any
   grant that names it (C3).
1. `New-CsOnlineLisCivicAddress` for each address that's used and not in Teams (captures `CivicAddressId`,
   `DefaultLocationId`).
2. `New-CsOnlineLisLocation` for each place that's used and not in Teams (captures `LocationId`).
3. `Set-CsOnlineLisSubnet` / `Set-CsOnlineLisWirelessAccessPoint` for each mapped network identifier.
   `New-CsTenantTrustedIPAddress` for each external subnet.
4. The existing user, common area phone and resource account steps, now with `-LocationId` on
   `Set-CsPhoneNumberAssignment` for any number that has a place. When the number is already right in Teams but
   its location isn't, a location-only `Set-CsPhoneNumberAssignment -TelephoneNumber -LocationId` instead of a
   reassignment. Steps 3 and 4 only for places whose address is validated (section 4.5).

**Rollback**: puts each number's previous location back with the location-only form (today rollback says it
can't), or `'null'` where it had none (Direct Routing and Operator Connect). Removes the subnets, access points
and trusted IPs a deployment added, then the places, then the addresses it created, only if no number in Teams
still uses them; otherwise it says what's left. **Verify** after a deploy
and **drift** after each Discovery sync compare the same objects (Discovery starts reading LIS subnets, access
points and trusted IPs in chunk C4).

## 7. Build chunks

Revised in 1.2: C0 is new and comes first; C2 and C3 gain the emergency calling policy and planned policies.

| Chunk | What ships | Live check |
|---|---|---|
| **C0 - Site switch, confirmation, notifications** | Migration (`e911_enabled`, the confirmation columns, `e911_notification`). Tenancy > Sites E911 switch (automatic for US sites). Site Data E911 tab: address confirmation with who and when, cleared when the address changes; notification requirements. Nothing changes in Teams. | A US site shows E911 without anyone switching it on; a UK site doesn't until switched on; a site contact confirms the address, and editing the address clears it. |
| **C1 - Addresses and places** | Migration (structured address fields, `discovery_locations`, place on subnets). Site Data Emergency locations tab, "Split this address". Discovery matching to live civic addresses/locations (section 4.1-4.2), shown read-only. | A US site: addresses split correctly, an address that exists in Teams shows "In Teams". |
| **C2 - Design & Build** | Emergency calling tab: `build_emergency_calling_policies`, made from the site's notification requirements, matched to Teams by name. Planned policies selectable for users and common area phones ("(planned)"), for emergency calling and Shared Calling policies. Emergency location column on users, CAPs and resource accounts; default place per site; migration of the old free-text `location_id`; the validation rules in section 5, including the validation gate (section 4.5). No deployment yet. | A site's policy made from its notifications; a user given it while it's planned; Calling Plan rows and Shared Calling resource accounts without a place show the error; other Direct Routing rows don't. |
| **C3 - Deploy policy, addresses and number locations** | Planner and worker: steps 0, 1, 2 and 4 of section 6 (the policy created or changed before the grants that name it; a planned choice moved to the live policy once Discovery finds it), id capture, the location-only form, What-If, verify, rollback. Simulated executor sample data. | **Real test tenant** (needed from you): dry run; create one address and one place; see whether the address comes back validated (section 4.5) and validate it in Teams admin center if not; give a number the place; re-run shows no changes; rollback puts the old location back and removes them. For a Calling Plan or Operator Connect number in the US, a test call to 933 reads the address back; for Direct Routing, the ERS provider's test service. |
| **C4 - Dynamic emergency calling** | Wi-Fi access points list; step 3 of section 6; Discovery reads `Get-CsOnlineLisSubnet`, `-WirelessAccessPoint`, `-Switch`, `-Port`, `Get-CsTenantTrustedIPAddress`; drift. | Test tenant: a subnet appears under Networks & locations in Teams admin center against the right place. |
| **C5 - Handover and docs** | Handover pack Emergency calling section and SBC/ERS checklist; `docs/DATA-MODEL.md`, `docs/DEPLOYMENT.md` (also fix the out-of-date AA/CQ statement), `docs/DISCOVERY.md`. | Generate a handover for a US site. |
| Later (not in Phase C) | Network sites with per-site emergency policies (`New-CsTenantNetworkSite`), switches and ports, bulk import of access points from CSV. | |

Tests in every chunk: database tests for the migrations and matching (`tests/db`), planner unit tests in
`packages/shared` (exact cmdlet text checked against Microsoft Learn), and the simulated executor for an
end-to-end run.

## 8. Risks

- **Real emergency calls depend on this.** A wrong address sends emergency services to the wrong place. So:
  Voxshift never edits an address it didn't create, every created address is shown for review in What-If, and
  the handover states where each number's location came from.
- **Address validation** (section 4.5) is likely to mean a manual step in Teams admin center for each new address.
  Found out in C3. If it does, Voxshift's job for addresses shrinks to matching and reminding; places, network
  links and number locations are still automated.
- **Shared Calling and network sites**: if a tenant has Shared Calling on Calling Plan or Operator Connect numbers
  as well as Direct Routing, emergency call routing policies can't be given to network sites. Matters for the
  later network-sites work, not for Phase C.
- **Four-hour delay** before clients see network changes: verify checks Teams' configuration, not a client.
- **Old free-text location ids** on resource accounts: mapped where they match, otherwise cleared and listed.

## 9. Checked against Microsoft Learn

Checked 2 November 2026. What changed in the plan as a result (version 1.0 to 1.1):

| Claim in 1.0 | What Learn says | Change |
|---|---|---|
| Number locations aren't used for Direct Routing | A Direct Routing number can have an emergency location (Teams admin center and `Set-CsPhoneNumberAssignment` both allow it). It's the last fallback after a dynamic location. A Shared Calling resource account's number **must** have one, whatever its type. | Location picker allowed on every number; required for Calling Plan and Shared Calling. |
| Calling Plan and Operator Connect both need one | Calling Plan needs one (US and Canada at assignment). For Operator Connect it depends on what the operator allows on the number. | Operator Connect without a place is not an error. |
| "Validation may be needed" (open question) | An address must be validated before a number or network identifier can use it. PowerShell-created addresses come back NotValidated; the validation parameters are Microsoft-internal. | New section 4.5: validation is a gate read from Discovery. |
| "Update in Teams" with `Set-CsOnlineLisCivicAddress` | Only addresses that aren't validated, and only in some countries. A validated address must be deleted and created again. | Update offered only in that case. |
| Rollback can't put a number's location back | `Set-CsPhoneNumberAssignment -TelephoneNumber -LocationId` changes only the location; `'null'` removes it for Direct Routing and Operator Connect. | Rollback restores locations. Planner also uses this form when only the location differs. |
| Address fields | Calling Plan requires house number, street, city, postal code, latitude, longitude, company name; state in the US and Canada; tax ID in some European countries; address must match the area code in six European countries; same country as its numbers. | Added to validation. |
| Network identifiers | Need a validated address with a geo code that isn't more than a couple of years old. Wi-Fi BSSIDs can end in a `*` wildcard (last one or two characters). Client matching order is Wi-Fi, switch/port, switch, subnet. Trusted IPs are only needed for subnet matching. | Added to section 1 and C4. |

Unchanged and confirmed: `New-CsOnlineLisCivicAddress` (latitude and longitude required except Australia and
Japan; returns `CivicAddressId` and `DefaultLocationId`), `New-CsOnlineLisLocation -Location -CivicAddressId
[-Elin]`, `Set-CsOnlineLisSubnet -Subnet -LocationId [-Description]` (network ID, not host address),
`Remove-CsOnlineLisLocation`/`-CivicAddress` (only when unused), the four-hour delay, and that the SBC's PIDF/LO
setting and the ERS provider or ELIN gateway are outside Teams configuration that Voxshift deploys.

Checked again 11 November 2026 for version 1.2: New-CsTeamsEmergencyCallingPolicy (notification mode, group of at
most 10 addresses and 50 people, dial-out number that can't be unmuted, external location lookup, disclaimer up to 350
characters, extended notifications per dial string) and New-CsTeamsEmergencyCallRoutingPolicy / New-CsTeamsEmergencyNumber
(emergency numbers with a dial string, masks and an existing PSTN usage; Direct Routing only).

Sources: Microsoft Learn pages for New-CsTeamsEmergencyCallingPolicy, New-CsTeamsEmergencyCallRoutingPolicy, New-CsTeamsEmergencyNumber, New-CsOnlineLisCivicAddress, New-/Set-/Remove-CsOnlineLisLocation,
Set-/Remove-CsOnlineLisCivicAddress, Set-CsOnlineLisSubnet, Set-CsOnlineLisWirelessAccessPoint,
Set-CsPhoneNumberAssignment; "Plan and configure dynamic emergency calling"; "Manage emergency calling";
"Manage emergency locations for your organization"; "Emergency calling considerations for Microsoft Calling
Plans"; "Considerations for Direct Routing"; "Emergency addresses for remote locations"; "Configure Shared Calling".

## 10. Questions to settle first

1. **Where addresses, places and subnets are entered.** This plan: in Site Data, where the site contact fills
   them in and confirms the address; Design & Build chooses the place for each user and deploys. The feature
   request says Design & Build enters them. Proposed: Site Data, as above.
2. **One emergency calling policy per site, or shared between sites?** Proposed: one per site by default
   ("E911-<site code>"), since who is notified usually differs by site; a site can pick another site's policy
   instead.
3. **The emergency call routing policy** (Direct Routing's emergency numbers and their routing): in this phase, or
   later? The feature request doesn't mention it.
4. **A real test tenant** for C3: needed to find out how address validation behaves and to test a 933 call.

## Build log

_Nothing built yet._
