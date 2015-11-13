import yauzl from 'yauzl';
import { singleLineString } from 'utils';

import { DuplicateZipEntryError } from 'exceptions';
import log from 'logger';


/*
 * Simple Promise wrapper for the Yauzl unzipping lib to unpack add-on .xpis.
 * Note: We're using the autoclose feature of yauzl as a result every operation
 * will open the zip, do something and then close it implicitly.
 * This makes the API easy to use and the consumer doesn't need to remember to
 * close the zipfile.
 *
 */

export default class Xpi {

  constructor(filename, zipLib=yauzl) {
    this.filename = filename;
    this.zipLib = zipLib;
    this.files = {};
    this.entries = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.zipLib.open(this.filename, (err, zipfile) => {
        if (err) {
          return reject(err);
        }
        resolve(zipfile);
      });
    });
  }

  handleEntry(entry, reject) {
    if (/\/$/.test(entry.fileName)) {
      return;
    }
    if (this.entries.indexOf(entry.fileName) > -1) {
      log.info('Found duplicate file entry: "%s" in package', entry.fileName);
      reject(new DuplicateZipEntryError(
        `Entry "${entry.fileName}" has already been seen`));
    }
    this.entries.push(entry.fileName);
    this.files[entry.fileName] = entry;
  }

  getFiles(_onEventsSubscribed) {
    return new Promise((resolve, reject) => {
      // If we have already processed the file and have data
      // on this instance return that.
      if (Object.keys(this.files).length) {
        return resolve(this.files);
      }

      return this.open()
        .then((zipfile) => {

          zipfile.on('entry', (entry) => {
            this.handleEntry(entry, reject);
          });

          // When the last entry has been processed
          // and the fd is closed resolve the promise.
          // Note: we cannot use 'end' here as 'end' is fired
          // after the last entry event is emitted and streams
          // may still be being read with openReadStream.
          zipfile.on('close', () => {
            resolve(this.files);
          });

          if (_onEventsSubscribed) {
            // Run optional callback when we know the event handlers
            // have been inited. Useful for testing.
            if (typeof _onEventsSubscribed === 'function') {
              _onEventsSubscribed();
            }
          }
        })
        .catch(reject);
    });
  }

  getFile(path, streamOrString='string') {
    switch (streamOrString) {
      case 'stream':
        return this.getFileAsStream(path);
      case 'string':
        return this.getFileAsString(path);
      default:
        throw new Error(singleLineString`Unexpected streamOrString
          value "${streamOrString}" should be "string" or "stream"`);
    }
  }

  getFileAsStream(path) {
    return new Promise((resolve, reject) => {

      if (!this.files.hasOwnProperty(path)) {
        throw new Error(`Path "${path}" does not exist in this XPI`);
      }

      return this.open()
        .then((zipfile) => {
          zipfile.openReadStream(this.files[path], (err, readStream) => {
            if (err) {
              return reject(err);
            }
            resolve(readStream);
          });
        })
        .catch(reject);
    });
  }

  getFileAsString(path) {
    return new Promise((resolve, reject) => {
      return this.getFileAsStream(path)
        .then((fileStream) => {
          var fileString = '';
          fileStream.on('data', (chunk) => {
            fileString += chunk;
          });

          // Once the file is assembled, resolve the promise.
          fileStream.on('end', () => {
            resolve(fileString);
          });
        })
        .catch(reject);
    });
  }

  getFilesByExt(...extensions) {

    for (let ext of extensions) {
      if (ext.indexOf('.') !== 0) {
        // We use Promise.reject as we're not inside a `then()` or a
        // Promise constructor callback.
        // If we throw here it won't be caught.
        return Promise.reject(new Error("File extension must start with '.'"));
      }
    }

    return this.getFiles()
      .then((xpiFiles) => {
        let files = [];

        for (let filename in xpiFiles) {
          for (let ext of extensions) {
            if (filename.endsWith(ext)) {
              files.push(filename);
            }
          }
        }

        return files;
      });
  }
}