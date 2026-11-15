// Export to Video (submit: file.exportVideo): the video's size, "Use Recorded Timings and Narrations" or "Don't Use Recorded Timings and Narrations", and the seconds spent on
// each slide that has none. PowerPoint's Create a Video page; not checked against upstream.

import {defineDialog} from '../../kernel/dialog.mjs';
import {QUALITIES} from '../commands/exportvideo.mjs';

export default defineDialog({
  id: 'dialog.exportVideo',
  title: 'Export to Video',
  command: 'file.exportVideo',
  init: () => ({quality: '720', timings: 'use', seconds: 5}),
  validate(v) {
    const out = [];
    if (!QUALITIES.some(q => q[0] === v.quality)) out.push({field: 'quality', message: 'Choose a video quality.'});
    const n = Number(v.seconds);
    if (!(n >= 1 && n <= 300)) out.push({field: 'seconds', message: 'Give 1 to 300 seconds for each slide.'});
    return out;
  },
  toCommand: v => ({command: 'file.exportVideo', params: {quality: v.quality, seconds: Number(v.seconds), useTimings: v.timings !== 'dont'}}),
});
