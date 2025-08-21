import { config } from '@/config';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import puppeteer from 'rebrowser-puppeteer';

const getUserInRealBrowser = (url, cache, displayLivePhoto: boolean) =>
    cache.tryGet(
        url,
        async () => {
            const browser = await puppeteer.launch({
                headless: false,
                executablePath: config.chromeExecutablePath,
                userDataDir: config.chromeUserDataDir,
                args: [config.chromeProfileDirectory ? `--profile-directory=${config.chromeProfileDirectory}` : '--profile-directory=Default', '--no-first-run', '--disable-features=DevToolsDebuggingRestrictions'],
                ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
            });
            try {
                const page = await browser.newPage();
                await page.setViewport({ width: 1920, height: 1080 });
                // await page.setRequestInterception(true);
                // page.on('request', (request) => {
                //     request.resourceType() === 'document' || request.resourceType() === 'script' || request.resourceType() === 'xhr' || request.resourceType() === 'other' ? request.continue() : request.abort();
                // });
                logger.http(`Requesting ${url}`);
                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                });
                await page.waitForSelector('#userPostedFeeds');

                const initialState = await page.evaluate(() => (window as any).__INITIAL_STATE__);

                // get all the `#userPostedFeeds section` which is a card for the note
                const noteCards = await page.$$('#userPostedFeeds section .cover.mask');
                await new Promise((resolve) => setTimeout(resolve, 10000));
                const limit = 5;
                let currentIndex = 0;
                const notes: Array<{
                    title: string;
                    description: string;
                    pubDate: Date;
                    updated: Date;
                }> = [];
                for (const noteCard of noteCards) {
                    // first check whether the noteCard dom contains text '置顶'
                    // if so, skip it
                    // eslint-disable-next-line no-await-in-loop
                    const isTop = await page.evaluate((el) => el.textContent?.includes('置顶'), noteCard);
                    if (isTop) {
                        continue;
                    }

                    if (currentIndex >= limit) {
                        break;
                    }
                    currentIndex++;
                    // click the note card
                    // eslint-disable-next-line no-await-in-loop
                    await noteCard.click();

                    try {
                        // eslint-disable-next-line no-await-in-loop
                        const response = await page.waitForResponse(
                            (res) => {
                                const req = res.request();
                                return req.url().includes('api/sns/web/v1/feed') && req.method() === 'POST';
                            },
                            { timeout: 5000 }
                        );
                        // eslint-disable-next-line no-await-in-loop
                        const data = await response.json();
                        const note = data.data.items[0].note_card;
                        notes.push(convertNoteCardData(note, displayLivePhoto));
                    } catch (error: unknown) {
                        logger.error(`error: ${error}`);
                    }
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setTimeout(resolve, 4000 + Math.random() * 3000));
                    // click .close-circle to close the note card
                    // eslint-disable-next-line no-await-in-loop
                    await page.click('.close-circle');

                    // eslint-disable-next-line no-await-in-loop
                    await new Promise((resolve) => setTimeout(resolve, 10000));
                }

                let { userPageData } = initialState.user;
                userPageData = userPageData._rawValue || userPageData;

                return { userPageData, notes };
            } finally {
                await browser.close();
            }
        },
        config.cache.routeExpire,
        false
    );

// const getBoard = (url, cache) =>
//     cache.tryGet(
//         url,
//         async () => {
//             const browser = await puppeteerUtil();
//             try {
//                 const page = await browser.newPage();
//                 await page.setRequestInterception(true);
//                 page.on('request', (request) => {
//                     request.resourceType() === 'document' || request.resourceType() === 'script' || request.resourceType() === 'xhr' ? request.continue() : request.abort();
//                 });
//                 logger.http(`Requesting ${url}`);
//                 await page.goto(url);
//                 await page.waitForSelector('.pc-container');
//                 const initialSsrState = await page.evaluate(() => (window as any).__INITIAL_SSR_STATE__);
//                 return initialSsrState.Main;
//             } finally {
//                 await browser.close();
//             }
//         },
//         config.cache.routeExpire,
//         false
//     );

function convertNoteCardData(note, displayLivePhoto) {
    logger.info(`note: ${JSON.stringify(note)}`);
    const title = note.title;
    let desc = note.desc;
    desc = desc.replaceAll(/\[.*?\]/g, '');
    desc = desc.replaceAll(/#(.*?)#/g, '#$1');
    desc = desc.replaceAll('\n', '<br>');
    const pubDate = parseDate(note.time, 'x');
    const updated = parseDate(note.last_update_time, 'x');

    let mediaContent = '';
    if (note.type === 'video') {
        const originVideoKey = note.video?.consumer?.origin_video_key;
        const videoUrls: string[] = [];

        if (originVideoKey) {
            videoUrls.push(`http://sns-video-al.xhscdn.com/${originVideoKey}`);
        }

        const streamTypes = ['av1', 'h264', 'h265', 'h266'];
        for (const type of streamTypes) {
            const streams = note.video?.media?.stream?.[type];
            if (streams?.length > 0) {
                const stream = streams[0];
                if (stream.masterUrl) {
                    videoUrls.push(stream.master_url);
                }
                if (stream.backup_urls?.length) {
                    videoUrls.push(...stream.backup_urls);
                }
            }
        }

        const posterUrl = note.image_list?.[0]?.url_default;

        if (videoUrls.length > 0) {
            mediaContent = `<video controls ${posterUrl ? `poster="${posterUrl}"` : ''}>
                    ${videoUrls.map((url) => `<source src="${url}" type="video/mp4">`).join('\n')}
                </video><br>`;
        }
    } else {
        mediaContent = note.image_list
            .map((image) => {
                if (image.live_photo && displayLivePhoto) {
                    const videoUrls: string[] = [];

                    const streamTypes = ['av1', 'h264', 'h265', 'h266'];
                    for (const type of streamTypes) {
                        const streams = image.stream?.[type];
                        if (streams?.length > 0) {
                            if (streams[0].master_url) {
                                videoUrls.push(streams[0].master_url);
                            }
                            if (streams[0].backup_urls?.length) {
                                videoUrls.push(...streams[0].backup_urls);
                            }
                        }
                    }

                    if (videoUrls.length > 0) {
                        return `<video controls poster="${image.url_default}">
                            ${videoUrls.map((url) => `<source src="${url}" type="video/mp4">`).join('\n')}
                        </video>`;
                    }
                }
                return `<img src="${image.url_default}">`;
            })
            .join('<br>');
    }

    const description = `${mediaContent}<br>${desc}`;
    const urlPrex = 'https://www.xiaohongshu.com/explore';
    const link = `${urlPrex}/${note.note_id}`;
    const guid = `${urlPrex}/${note.note_id}`;
    const convertedNote = {
        link,
        guid,
        title: title || note.desc,
        description,
        pubDate,
        updated,
        author: note.user.nickname,
    };
    return convertedNote;
}

export { getUserInRealBrowser };
