/* eslint-disable no-console */
import chalk from 'chalk';
import gaze from 'gaze/lib/gaze.js';
import StaticServer from 'static-server/server.js';

import { buildCSS } from './build_css.js';


gaze(['css/**/*.css'], (err, watcher) => {
  watcher.on('all', () => buildCSS());
});

const port = process.env.PORT || 8080;
const server = new StaticServer({ rootPath: process.cwd(), port: port, followSymlink: true });
server.start(() => {
  console.log(chalk.yellow(`Listening on ${server.port}`));
});
