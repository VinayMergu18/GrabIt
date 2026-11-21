'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFullFormatsFromMeta, detectYouTubeType } = require('../modules/detector');

test('a YouTube watch URL with a playlist parameter remains a single video', () => {
  assert.equal(
    detectYouTubeType('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123'),
    'video'
  );
  assert.equal(
    detectYouTubeType('https://www.youtube.com/playlist?list=PL123'),
    'playlist'
  );
  assert.equal(
    detectYouTubeType('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD123'),
    'video'
  );
});

test('YouTube format rows only show available resolutions and estimate merged sizes', () => {
  const { videoFormats } = buildFullFormatsFromMeta({
    duration: 100,
    filesize_approx: 5_000_000,
    formats: [
      { format_id: 'v1080', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, filesize: 100_000_000 },
      { format_id: 'v720', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, filesize: 40_000_000 },
      { format_id: 'a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 10_000_000 }
    ]
  });

  assert.deepEqual(videoFormats.map(format => format.height), [1080, 720]);
  assert.equal(videoFormats[0].size, 110_000_000);
  assert.equal(videoFormats[0].sizeIsEstimate, false);
  assert.equal(videoFormats[0].isRecommended, false);
  assert.equal(videoFormats[1].isRecommended, true);
});

test('bitrate-derived YouTube sizes are marked as estimates', () => {
  const { videoFormats } = buildFullFormatsFromMeta({
    duration: 60,
    formats: [
      { format_id: 'v720', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, vbr: 500 },
      { format_id: 'a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
    ]
  });

  assert.equal(videoFormats[0].size, 4_710_000);
  assert.equal(videoFormats[0].sizeIsEstimate, true);
});
