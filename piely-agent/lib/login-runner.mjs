// Runs an interactive login and keeps it cancellable. Closing the dialog in the
// app aborts the flow; otherwise it keeps polling and holds the provider's
// callback port, and the next login cannot start.

/**
 * @param {object} io
 * @param {(message: object) => void} io.send writes one NDJSON message
 * @param {Map<string, (value: string | undefined) => void>} io.answerResolvers
 *   pending prompt answers, keyed by request id
 */
export function createLoginRunner({ send, answerResolvers }) {
  let active = null; // { id, controller } while a login is interactive

  return {
    /**
     * Runs one login to completion. `models.login` is injected so tests can
     * observe how the interaction is wired.
     */
    async login({ models, provider, type, requestId }) {
      const controller = new AbortController();
      active = { id: requestId, controller };

      try {
        await models.login(
          provider,
          type ?? "oauth",
          {
            signal: controller.signal,
            prompt: (prompt) =>
              new Promise((resolve) => {
                // A prompt created after the abort never fires the listener
                // below, so an already-aborted signal has to settle at once.
                if (prompt.signal?.aborted) {
                  resolve(undefined);
                  return;
                }
                answerResolvers.set(requestId, resolve);
                send({ id: requestId, type: "prompt", prompt });
                // manual_code prompts race a local callback server; when the
                // server wins the flow aborts the prompt and continues on its own.
                prompt.signal?.addEventListener("abort", () => {
                  answerResolvers.delete(requestId);
                  resolve(undefined);
                });
              }),
            notify: (event) => send({ id: requestId, type: "notify", event }),
          },
          {}
        );
      } finally {
        if (active?.id === requestId) active = null;
        answerResolvers.delete(requestId);
      }
    },

    /** Aborts the running login, if any. Safe to call when none is running. */
    cancel() {
      const login = active;
      active = null;
      if (!login) return;

      login.controller.abort();
      // Settle a prompt that is already on screen, so the flow unwinds now
      // instead of waiting for the user to type something.
      const resolve = answerResolvers.get(login.id);
      answerResolvers.delete(login.id);
      resolve?.(undefined);
    },
  };
}
