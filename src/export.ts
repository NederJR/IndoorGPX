// Exporta o pedal em TCX (com potência, cadência e FC) para envio ao Strava/Garmin Connect.

export interface Sample {
  time: number; // epoch ms
  lat: number;
  lon: number;
  ele: number;
  distance: number; // metros desde o início do pedal
  speed: number; // m/s
  power: number;
  cadence: number;
  heartRate: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function buildTcx(samples: Sample[], movingTimeSec: number, notes: string): string {
  if (!samples.length) throw new Error('Nenhum dado gravado.');
  const start = iso(samples[0].time);
  const last = samples[samples.length - 1];
  const maxSpeed = samples.reduce((m, s) => Math.max(m, s.speed), 0);
  const hrs = samples.filter((s) => s.heartRate > 0).map((s) => s.heartRate);

  const points = samples
    .map((s) => {
      const hr = s.heartRate > 0 ? `<HeartRateBpm><Value>${Math.round(s.heartRate)}</Value></HeartRateBpm>` : '';
      return (
        `<Trackpoint><Time>${iso(s.time)}</Time>` +
        `<Position><LatitudeDegrees>${s.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${s.lon.toFixed(7)}</LongitudeDegrees></Position>` +
        `<AltitudeMeters>${s.ele.toFixed(1)}</AltitudeMeters>` +
        `<DistanceMeters>${s.distance.toFixed(1)}</DistanceMeters>${hr}` +
        `<Cadence>${Math.min(254, Math.round(s.cadence))}</Cadence>` +
        `<Extensions><ns3:TPX><ns3:Speed>${s.speed.toFixed(2)}</ns3:Speed><ns3:Watts>${Math.round(s.power)}</ns3:Watts></ns3:TPX></Extensions>` +
        `</Trackpoint>`
      );
    })
    .join('\n');

  const hrSummary = hrs.length
    ? `<AverageHeartRateBpm><Value>${Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)}</Value></AverageHeartRateBpm>` +
      `<MaximumHeartRateBpm><Value>${hrs.reduce((m, h) => Math.max(m, h), 0)}</Value></MaximumHeartRateBpm>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
<Activities><Activity Sport="Biking"><Id>${start}</Id>
<Lap StartTime="${start}"><TotalTimeSeconds>${movingTimeSec.toFixed(0)}</TotalTimeSeconds><DistanceMeters>${last.distance.toFixed(1)}</DistanceMeters><MaximumSpeed>${maxSpeed.toFixed(2)}</MaximumSpeed><Calories>0</Calories>${hrSummary}<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
<Track>
${points}
</Track></Lap>
<Notes>${escapeXml(notes)}</Notes>
<Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>IndoorGPX</Name><UnitId>0</UnitId><ProductID>0</ProductID></Creator>
</Activity></Activities>
</TrainingCenterDatabase>
`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

export function downloadFile(name: string, content: string, type = 'application/xml') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
