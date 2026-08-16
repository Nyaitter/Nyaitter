function startModerationAssignmentScheduler(
  moderationReportService,
  { intervalMs = 5 * 60 * 1000, logger = console } = {},
) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const assigned = await moderationReportService.runAssignmentSweep();
      if (assigned.length > 0) {
        logger.info?.(`[moderation] Assigned or reassigned ${assigned.length} report(s).`);
      }
    } catch (error) {
      logger.error?.('[moderation] Assignment sweep failed:', error);
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();

  return {
    run,
    stop: () => clearInterval(timer),
  };
}

module.exports = { startModerationAssignmentScheduler };
