import { mountApp } from './ui/app';
import './ui/style.css';

const root = document.getElementById('root');
if (root) {
  mountApp(root);
}
