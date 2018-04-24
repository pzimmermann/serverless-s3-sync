'use strict';

const BbPromise = require('bluebird');
const AWS = require('aws-sdk');
const s3 = require('@monolambda/s3');
const chalk = require('chalk');
const minimatch = require('minimatch');

const messagePrefix = 'S3 Sync: ';

class ServerlessS3Sync {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.s3Sync = this.serverless.service.custom.s3Sync;
    this.servicePath = this.serverless.service.serverless.config.servicePath;

    this.commands = {
      s3sync: {
        usage: 'Sync directories and S3 prefixes',
        lifecycleEvents: [
          'sync'
        ]
      }
    };

    this.hooks = {
      'aws:deploy:deploy:uploadArtifacts': () => BbPromise.bind(this).then(this.syncArtifact),
      'after:deploy:deploy': () => BbPromise.bind(this).then(this.syncDeploy),
      'before:remove:remove': () => BbPromise.bind(this).then(this.clear),
      's3sync:sync': () => BbPromise.bind(this).then(this.syncArtifact).then(this.syncDeploy)
    };
  }

  client() {
    const awsCredentials = this.serverless.getProvider('aws').getCredentials();
    return s3.createClient({
      s3Client: new AWS.S3({
        region: awsCredentials.region,
        credentials: awsCredentials.credentials
      })
    });
  }

  syncArtifact() {
    return this.sync(true);
  }

  syncDeploy() {
    return this.sync(false);
  }

  sync(isArtifact) {
    if (!Array.isArray(this.s3Sync)) {
      return Promise.resolve();
    }
    const cli = this.serverless.cli;
    cli.consoleLog(`${messagePrefix}${chalk.yellow('Syncing directories and S3 prefixes...')} artifact:${isArtifact}`);
    const servicePath = this.servicePath;
    const promises = this.s3Sync.map((s) => {
      let bucketPrefix = '';
      let artifact = false;
      if (s.hasOwnProperty('artifact')) {
        artifact = s.artifact;
      }
      if(artifact != isArtifact) {
        return Promise.resolve();
      }
      if (s.hasOwnProperty('bucketPrefix')) {
        bucketPrefix = s.bucketPrefix;
      }
      let acl = 'private';
      if (s.hasOwnProperty('acl')) {
        acl = s.acl;
      }
      let followSymlinks = false;
      if (s.hasOwnProperty('followSymlinks')) {
        followSymlinks = s.followSymlinks;
      }
      if (!s.bucketName || !s.localDir) {
        throw 'Invalid custom.s3Sync';
      }
      cli.consoleLog(`${messagePrefix}${chalk.yellow(s.localDir)} -> ${chalk.yellow(s.bucketName+"/"+bucketPrefix)}`);
      return new Promise((resolve) => {
        const localDir = [servicePath, s.localDir].join('/');

        const params = {
          maxAsyncS3: 5,
          localDir,
          deleteRemoved: true,
          followSymlinks: followSymlinks,
          getS3Params: (localFile, stat, cb) => {
            const s3Params = {};

            if(Array.isArray(s.params)) {
              s.params.forEach((param) => {
                const glob = Object.keys(param)[0];
                if(minimatch(localFile, `${localDir}/${glob}`)) {
                  Object.assign(s3Params, param[glob] || {});
                }
              });
            }

            cb(null, s3Params);
          },
          s3Params: {
            Bucket: s.bucketName,
            Prefix: bucketPrefix,
            ACL: acl
          }
        };
        const uploader = this.client().uploadDir(params);
        uploader.on('error', (err) => {
          throw err;
        });
        let percent = 0;
        uploader.on('progress', () => {
          if (uploader.progressTotal === 0) {
            return;
          }
          const current = Math.round((uploader.progressAmount / uploader.progressTotal) * 10) * 10;
          if (current > percent) {
            percent = current;
            cli.printDot();
          }
        });
        uploader.on('end', () => {
          resolve('done');
        });
      });
    });
    return Promise.all(promises)
      .then(() => {
        cli.printDot();
        cli.consoleLog('');
        cli.consoleLog(`${messagePrefix}${chalk.yellow('Synced.')}`);
      });
  }

  clear() {
    if (!Array.isArray(this.s3Sync)) {
      return Promise.resolve();
    }
    const cli = this.serverless.cli;
    cli.consoleLog(`${messagePrefix}${chalk.yellow('Removing S3 objects...')}`);
    const promises = this.s3Sync.map((s) => {
      let bucketPrefix = '';
      if (s.hasOwnProperty('bucketPrefix')) {
        bucketPrefix = s.bucketPrefix;
      }
      return new Promise((resolve) => {
        const params = {
          Bucket: s.bucketName,
          Prefix: bucketPrefix
        };
        const uploader = this.client().deleteDir(params);
        uploader.on('error', (err) => {
          throw err;
        });
        let percent = 0;
        uploader.on('progress', () => {
          if (uploader.progressTotal === 0) {
            return;
          }
          const current = Math.round((uploader.progressAmount / uploader.progressTotal) * 10) * 10;
          if (current > percent) {
            percent = current;
            cli.printDot();
          }
        });
        uploader.on('end', () => {
          resolve('done');
        });
      });
    });
    return Promise.all(promises)
      .then(() => {
        cli.printDot();
        cli.consoleLog('');
        cli.consoleLog(`${messagePrefix}${chalk.yellow('Removed.')}`);
      });
  }
}

module.exports = ServerlessS3Sync;
