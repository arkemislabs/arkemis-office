// Audio & Video Settings: the microphone and camera the system lists, the audio quality and the video size, over
// core/slate/dialogs/audio-video-settings.mjs. U:slate/rest.

import {useEffect, useState} from 'react';
import {Field, grid, type BodyProps} from './shared';

type Option = {value: string; label: string};
const QUALITY: Option[] = [{value: 'low', label: 'Low (32 kbit/s)'}, {value: 'medium', label: 'Medium (64 kbit/s)'}, {value: 'high', label: 'High (128 kbit/s)'}];
const SIZE: Option[] = [{value: 'small', label: 'Small (320 x 240)'}, {value: 'medium', label: 'Medium (640 x 480)'}, {value: 'large', label: 'Large (1280 x 720)'}];
const DEFAULT: Option = {value: '', label: 'System default'};

function Body({dialog: d, setValue: set}: BodyProps) {
  const v = d.values as {audioInput?: string; videoInput?: string};
  const [mics, setMics] = useState<Option[]>([DEFAULT]);
  const [cams, setCams] = useState<Option[]>([DEFAULT]);
  useEffect(() => {
    let live = true;
    const devices = (navigator as any).mediaDevices;
    if (typeof devices?.enumerateDevices !== 'function') return;
    // Device names show only once the system has let the app use the microphone or camera; until then they are numbered.
    devices.enumerateDevices().then((all: MediaDeviceInfo[]) => {
      if (!live) return;
      const make = (kind: string, noun: string): Option[] => [DEFAULT, ...all.filter(x => x.kind === kind && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications')
        .map((x, i) => ({value: x.deviceId, label: x.label || `${noun} ${i + 1}`}))];
      setMics(make('audioinput', 'Microphone'));
      setCams(make('videoinput', 'Camera'));
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  // A device chosen earlier that the system no longer lists stays selectable, so OK does not lose it.
  const keep = (list: Option[], value?: string) => (value && !list.some(o => o.value === value) ? [...list, {value, label: 'Chosen device (not found now)'}] : list);
  return <div className="gd-fields" data-dialog-page="Audio & Video">
    <div style={grid('minmax(0, 1fr)', {gap: 12})}>
      <Field d={d} id="audioInput" set={set} options={keep(mics, v.audioInput)}/>
      <Field d={d} id="audioQuality" set={set} options={QUALITY}/>
      <Field d={d} id="videoInput" set={set} options={keep(cams, v.videoInput)}/>
      <Field d={d} id="videoSize" set={set} options={SIZE}/>
    </div>
    <p style={{margin: '10px 0 0', fontSize: 12, opacity: 0.75}}>These are used when a recording starts. A recording already running is not changed.</p>
  </div>;
}

export default {Body};
