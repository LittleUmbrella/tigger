/**
 * Debounced wake runner — coalesces rapid triggers (e.g. harvest push + poll) into one run.
 */
export const createChannelWake = (run: (channel: string) => Promise<void>) => {
  const inFlight = new Map<string, Promise<void>>();
  const pending = new Set<string>();

  const drain = async (channel: string): Promise<void> => {
    pending.delete(channel);
    await run(channel);
    if (pending.has(channel)) {
      await drain(channel);
    }
  };

  return (channel: string): void => {
    if (inFlight.has(channel)) {
      pending.add(channel);
      return;
    }
    const job = drain(channel).finally(() => {
      inFlight.delete(channel);
    });
    inFlight.set(channel, job);
  };
};
