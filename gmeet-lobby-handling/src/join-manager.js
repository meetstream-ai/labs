/**
 * Decides what to do when a bot never makes it out of the Google Meet lobby.
 *
 * Policy:
 *   NotAllowed (lobby timeout)  -> retry, up to MAX_JOIN_ATTEMPTS, with a longer
 *                                  waiting_room_timeout each time. Nobody said no;
 *                                  the host was probably just late.
 *   Denied (host rejected)      -> never retry. A human explicitly said no, and
 *                                  retrying just spams them. Notify instead.
 *   Error                       -> do not retry blindly. Notify with the bot id so
 *                                  you can inspect GET /bots/{id}/detail.
 *   Stopped                     -> nothing to do, that is a clean exit.
 *
 * It also runs a "still in the lobby" nudge: if the bot is still waiting after
 * lobbyAlertSeconds, alert a human who can admit it, well before the timeout fires.
 */

import { LOBBY_OUTCOME, classify } from './outcomes.js';
import { WAITING_ROOM_MAX_GMEET, createLobbyAwareBot } from './bot.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class JoinManager {
  /**
   * @param {object} opts
   * @param {ReturnType<import('./client.js').createClient>} opts.client
   * @param {object} opts.botOptions           passed through to createLobbyAwareBot
   * @param {number} opts.maxAttempts
   * @param {number} opts.retryDelaySeconds    wait before re-sending a bot
   * @param {number} opts.timeoutEscalation    seconds added to waiting_room_timeout per retry
   * @param {number} opts.lobbyAlertSeconds    nudge a human after this long in the lobby (0 = off)
   * @param {object} opts.notifier
   * @param {() => void} [opts.onFinished]     called once the run reaches a final state
   */
  constructor({
    client,
    botOptions,
    maxAttempts = 2,
    retryDelaySeconds = 30,
    timeoutEscalation = 120,
    lobbyAlertSeconds = 60,
    notifier,
    onFinished,
  }) {
    this.client = client;
    this.botOptions = botOptions;
    this.maxAttempts = Math.max(1, maxAttempts);
    this.retryDelaySeconds = retryDelaySeconds;
    this.timeoutEscalation = timeoutEscalation;
    this.lobbyAlertSeconds = lobbyAlertSeconds;
    this.notifier = notifier;
    this.onFinished = onFinished;

    this.attempt = 0;
    this.currentBotId = null;
    this.finished = false;
    this.lobbyTimer = null;
    this.history = [];
  }

  currentWaitingRoomTimeout() {
    const base = this.botOptions.waitingRoomTimeout;
    const escalated = base + this.timeoutEscalation * Math.max(0, this.attempt - 1);
    return Math.min(escalated, WAITING_ROOM_MAX_GMEET);
  }

  async start() {
    this.attempt += 1;
    const waitingRoomTimeout = this.currentWaitingRoomTimeout();

    const { bot, replayed, request } = await createLobbyAwareBot(this.client, {
      ...this.botOptions,
      waitingRoomTimeout,
      customAttributes: {
        ...(this.botOptions.customAttributes ?? {}),
        // custom_attributes values must be strings; they are echoed in every webhook.
        join_attempt: String(this.attempt),
      },
    });

    this.currentBotId = bot?.bot_id ?? null;
    this.history.push({ attempt: this.attempt, botId: this.currentBotId, waitingRoomTimeout });

    await this.notifier.info(
      `Attempt ${this.attempt}/${this.maxAttempts}: bot dispatched${replayed ? ' (507 replay)' : ''}`,
      {
        bot_id: this.currentBotId,
        transcript_id: bot?.transcript_id ?? null,
        waiting_room_timeout: `${waitingRoomTimeout}s`,
        signed_in: request.google_meet ? request.google_meet.google_login_domain : 'no (anonymous)',
      }
    );

    return bot;
  }

  clearLobbyTimer() {
    if (this.lobbyTimer) {
      clearTimeout(this.lobbyTimer);
      this.lobbyTimer = null;
    }
  }

  armLobbyTimer(botId) {
    if (!this.lobbyAlertSeconds) return;
    this.clearLobbyTimer();
    this.lobbyTimer = setTimeout(() => {
      this.notifier.warn(
        `Bot has been in the Google Meet lobby for ${this.lobbyAlertSeconds}s and nobody has admitted it`,
        {
          bot_id: botId,
          gives_up_in: `${this.currentWaitingRoomTimeout() - this.lobbyAlertSeconds}s`,
          hint:
            'With Host management on, only the host and co-hosts can see the admission request. ' +
            'Ask one of them to open the People panel.',
        }
      );
    }, this.lobbyAlertSeconds * 1000);
    // Do not hold the event loop open just for the nudge.
    this.lobbyTimer.unref?.();
  }

  finish(summary) {
    if (this.finished) return;
    this.finished = true;
    this.clearLobbyTimer();
    this.onFinished?.(summary);
  }

  /** Feed every webhook payload in here. */
  async handleEvent(payload) {
    const info = classify(payload);

    // Ignore events for bots from earlier attempts (or unrelated bots).
    if (info.botId && this.currentBotId && info.botId !== this.currentBotId) {
      console.log(`  (ignoring ${info.event} for another bot ${info.botId})`);
      return;
    }

    console.log(
      `  <- ${info.event ?? 'unknown event'}  bot_status=${info.status ?? '-'}` +
        (info.message ? `  "${info.message}"` : '')
    );

    if (info.waiting) {
      this.armLobbyTimer(info.botId ?? this.currentBotId);
      return;
    }

    if (info.admitted) {
      this.clearLobbyTimer();
      await this.notifier.info('Bot was admitted to the meeting', { bot_id: info.botId });
      return;
    }

    if (!info.terminal) return;

    this.clearLobbyTimer();

    switch (info.outcome) {
      case LOBBY_OUTCOME.NOT_ALLOWED:
        await this.handleNotAllowed(info);
        return;

      case LOBBY_OUTCOME.DENIED:
        await this.notifier.error('Host denied the bot', {
          bot_id: info.botId,
          reason: info.reason,
          action:
            'Not retrying - someone said no on purpose. Ask the organiser to expect the bot, or ' +
            'use a signed-in bot whose account is on the calendar invite.',
        });
        this.finish({ outcome: info.outcome, attempts: this.attempt });
        return;

      case LOBBY_OUTCOME.ERROR:
        await this.notifier.error('Bot failed with an error', {
          bot_id: info.botId,
          message: info.message,
          action: `Inspect GET /bots/${info.botId}/detail.`,
        });
        this.finish({ outcome: info.outcome, attempts: this.attempt });
        return;

      default:
        // Stopped: clean exit. It may have recorded a whole meeting first.
        await this.notifier.info('Bot exited cleanly', {
          bot_id: info.botId,
          message: info.message,
        });
        this.finish({ outcome: info.outcome ?? 'Stopped', attempts: this.attempt });
    }
  }

  async handleNotAllowed(info) {
    if (this.attempt >= this.maxAttempts) {
      await this.notifier.error('Bot was never admitted, and retries are exhausted', {
        bot_id: info.botId,
        attempts: this.attempt,
        reason: info.reason,
        action:
          'The durable fix is a signed-in bot whose Google account is on the calendar invite - ' +
          'invited participants bypass the lobby.',
      });
      this.finish({ outcome: LOBBY_OUTCOME.NOT_ALLOWED, attempts: this.attempt });
      return;
    }

    await this.notifier.warn('Lobby timeout - retrying', {
      bot_id: info.botId,
      attempt: `${this.attempt}/${this.maxAttempts}`,
      retry_in: `${this.retryDelaySeconds}s`,
      next_waiting_room_timeout: `${Math.min(
        this.botOptions.waitingRoomTimeout + this.timeoutEscalation * this.attempt,
        WAITING_ROOM_MAX_GMEET
      )}s`,
    });

    await sleep(this.retryDelaySeconds * 1000);

    try {
      await this.start();
    } catch (error) {
      await this.notifier.error('Retry failed to create a bot', { error: error.message });
      this.finish({ outcome: 'RetryFailed', attempts: this.attempt });
    }
  }
}
