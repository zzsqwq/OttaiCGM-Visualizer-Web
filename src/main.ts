import './styles.css';
import { App } from './ui/app';

const app = new App();
void app.start();

// 方便在控制台里调试（也可以让自动化测试驱动）
declare global {
  interface Window {
    __ottai?: unknown;
  }
}
window.__ottai = { app };
