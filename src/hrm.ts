// Cinta/sensor de frequência cardíaca via Bluetooth LE (Heart Rate Service).

import type { ConnectionStatus } from './ftms';

export class HeartRateMonitor {
  onHeartRate?: (bpm: number) => void;
  onStatus?: (status: ConnectionStatus, message?: string) => void;

  private device?: BluetoothDevice;
  private _status: ConnectionStatus = 'disconnected';

  get status(): ConnectionStatus {
    return this._status;
  }

  get name(): string {
    return this.device?.name ?? 'Monitor de FC';
  }

  private setStatus(status: ConnectionStatus, message?: string) {
    this._status = status;
    this.onStatus?.(status, message);
  }

  async connect(): Promise<void> {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    this.device.addEventListener('gattserverdisconnected', () => this.setStatus('disconnected'));
    this.setStatus('connecting');
    try {
      const server = await this.device.gatt!.connect();
      const service = await server.getPrimaryService('heart_rate');
      const measurement = await service.getCharacteristic('heart_rate_measurement');
      measurement.addEventListener('characteristicvaluechanged', (event) => {
        const v = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!v || v.byteLength < 2) return;
        const is16bit = v.getUint8(0) & 0x01;
        this.onHeartRate?.(is16bit ? v.getUint16(1, true) : v.getUint8(1));
      });
      await measurement.startNotifications();
      this.setStatus('connected');
    } catch (err) {
      this.setStatus('disconnected', String(err));
      throw err;
    }
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }
}
