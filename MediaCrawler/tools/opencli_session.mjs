// Copyright (c) 2025 relakkes@gmail.com
// Part of MediaCrawler. Licensed under NON-COMMERCIAL LEARNING LICENSE 1.1.
// Private IPC: never invoke this script with stdout redirected to a shared log.
import { Page } from '@jackwener/opencli/browser/page';

try {
  const url = process.argv[2];
  if (!['https://www.xiaohongshu.com', 'https://www.rednote.com'].includes(url)) {
    throw new Error('Unsupported cookie origin');
  }
  // No navigation, new tabs, login automation or changes to the user's browser.
  // An explicit context ID is required when multiple browser profiles are connected.
  const page = new Page('mediacrawler-xhs', undefined, process.env.OPENCLI_CONTEXT_ID);
  const cookies = await page.getCookies({ url });
  process.stdout.write(JSON.stringify(cookies));
} catch {
  // Do not forward bridge output: it may contain private browser/session details.
  process.stderr.write('Cannot read OpenCLI browser cookies. Check the daemon, extension and profile.\n');
  process.exitCode = 1;
}
