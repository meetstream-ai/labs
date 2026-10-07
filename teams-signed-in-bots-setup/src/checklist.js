/**
 * The Microsoft 365 side of the setup. None of this is an API call: it is what
 * has to be true in your tenant before a signed-in Teams bot can log in.
 */

export const CHECKLIST = `
Microsoft 365 prerequisites (do these in Microsoft, before touching MeetStream)
-------------------------------------------------------------------------------

  [ ] 1. A DEDICATED Microsoft 365 tenant just for bot accounts.
         Not your production tenant: the settings below weaken sign-in security,
         so keep them away from real users.

  [ ] 2. A licence that includes Teams: Microsoft 365 Business Basic or higher,
         one per bot account.

  [ ] 3. One regular, NON-admin, licensed user per bot, with a sign-in email on
         the domain you will register (for example bot1@bots.acme.com).
         Give it a permanent password: untick "require this user to change their
         password when they first sign in", or sign in once yourself and set it.
         Set the display name and profile photo you want meetings to show - a
         signed-in bot uses these, not bot_name / bot_image_url.

  [ ] 4. Security defaults turned OFF for the tenant
         (Microsoft Entra admin center -> Overview -> Properties ->
         Manage security defaults). Otherwise Microsoft forces an MFA
         registration prompt the bot cannot answer.

  [ ] 5. Self-service password reset (SSPR) set to None for the bot accounts
         (Entra admin center -> Password reset -> Properties), so sign-in is
         never interrupted by a "more information required" screen.

  [ ] 6. Meetings are Microsoft 365 work or school Teams (teams.microsoft.com).
         Teams for personal use (teams.live.com) is not supported.

  Capacity: one account runs ONE bot at a time. For N simultaneous signed-in
  bots, create and register N accounts.
`;

export const STEPS = `
MeetStream side (this CLI)
--------------------------

  1. Register the login domain       node index.js register-domain
  2. Register the bot accounts       node index.js add-accounts
  3. Check accounts and leases       node index.js status
  4. Pre-flight the bot config       node index.js verify
  5. Send a signed-in bot            node index.js create-bot

  Or run 1-3 (and 5 if MEETING_LINK is set) in one go:
                                     node index.js setup

  Add --dry-run to any command to print the request it would send (passwords
  redacted) without calling the API.
`;
