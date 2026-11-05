/**
 * Turns the documented Teams signed-in bot errors into "what to do next".
 *
 * create_bot with a `teams` block:
 *   400  teams.teams_login_domain '<d>' is not registered
 *   403  the domain or account belongs to another MeetStream account
 *   404  sign_in_email is not registered under the domain
 *   409  pinned account busy or deactivated (strict_email true), or no account
 *        is both active and free
 *   429  all Teams logins in the domain are in use
 *
 * Login management:
 *   400  GET /teams-logins without ?domain=
 *   403  the domain or login belongs to another MeetStream account
 *   404  { error: "Domain not found" } / "Domain <d> not registered" / "Login not found"
 */

function has(error, pattern) {
  return pattern.test(error.message ?? '');
}

export function hintsFor(error) {
  const status = error?.status;
  const path = error?.path ?? '';
  const hints = [];

  if (status === 401) {
    hints.push('MEETSTREAM_API_KEY is missing or malformed. The header is "Authorization: Token <key>".');
    return hints;
  }

  if (path.startsWith('/bots/create_bot')) {
    switch (status) {
      case 400:
        if (has(error, /not registered/i)) {
          hints.push(
            'TEAMS_LOGIN_DOMAIN is not registered on this API key. Register it and add accounts:',
            '  node index.js register-domain',
            '  node index.js add-accounts'
          );
        } else {
          hints.push(
            'Check the request body printed above. On Teams, waiting_room_timeout must be 60-1800.'
          );
        }
        break;
      case 403:
        hints.push(
          'The login domain or the sign_in_email belongs to a different MeetStream account.',
          'Logins are scoped to the account that registered them: use that account\'s API key,',
          'or register a domain this account owns. (A 403 can also mean the key itself is not',
          'valid for this workspace.)'
        );
        break;
      case 404:
        hints.push(
          'SIGN_IN_EMAIL is not registered under TEAMS_LOGIN_DOMAIN.',
          'See what is registered with "node index.js status", or add it with "node index.js add-accounts".'
        );
        break;
      case 409:
        hints.push(
          'No account could take this bot. Either:',
          '  - the pinned SIGN_IN_EMAIL is busy in another meeting or deactivated, and strict_email',
          '    is true (the API default). Set STRICT_EMAIL=false to fall back to any free account; or',
          '  - no account in the domain is both active and free.',
          'A deactivated account comes back with "node index.js rotate-password <email>" (a new',
          'password reactivates it) or "node index.js enable <email>". Check lease_status and',
          'last_login_error with "node index.js status".'
        );
        break;
      case 429:
        hints.push(
          'All Teams accounts in this domain are in use. One account runs one bot at a time,',
          'so N concurrent signed-in bots need N accounts. Wait for a bot to leave, or register',
          'more accounts with "node index.js add-accounts".'
        );
        break;
      default:
        break;
    }
    return hints;
  }

  if (path.startsWith('/teams-login')) {
    switch (status) {
      case 400:
        hints.push('The API rejected the request body. Re-run with --dry-run to see exactly what was sent (passwords redacted).');
        break;
      case 403:
        hints.push(
          'That domain or login belongs to a different MeetStream account. Use the API key of the',
          'account that registered it.'
        );
        break;
      case 404:
        if (path.startsWith('/teams-logins/')) {
          hints.push('No login with that id on this API key. "node index.js status" lists them.');
        } else {
          hints.push(
            'That domain is not registered on this API key. Run "node index.js register-domain",',
            'or "node index.js status" to see what is.'
          );
        }
        break;
      case 409:
        hints.push(
          'Conflict: it may already be registered. Run "node index.js status" to check. To change',
          'an existing account\'s password use rotate-password rather than adding it again.'
        );
        break;
      default:
        break;
    }
  }

  return hints;
}
