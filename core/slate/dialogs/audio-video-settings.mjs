// Audio & Video Settings (Audio & Video > Options > Audio & Video Settings; submit: media.settings).
// OneNote's Options page for recordings: the microphone and camera, and the quality recordings are
// made at. The device lists come from the system when the dialog is open (see the dialog body). U:slate/rest.
import {defineDialog} from '../../kernel/dialog.mjs';
import {AV_QUALITY, VIDEO_SIZES, avSettings} from '../commands/rest-panes.mjs';

export default defineDialog({
  id: 'dialog.audio-video-settings',
  title: 'Audio & Video Settings',
  command: 'media.settings',
  init: ctx => ({...avSettings(ctx.prefs), microphones: [], cameras: []}),
  validate(v) {
    const out = [];
    if (!Object.hasOwn(AV_QUALITY, v.audioQuality)) out.push({field: 'audioQuality', message: 'Choose an audio quality.'});
    if (!Object.hasOwn(VIDEO_SIZES, v.videoSize)) out.push({field: 'videoSize', message: 'Choose a video size.'});
    return out;
  },
  toCommand: v => ({command: 'media.settings', params: {audioInput: String(v.audioInput ?? ''), videoInput: String(v.videoInput ?? ''), audioQuality: v.audioQuality, videoSize: v.videoSize}}),
});
