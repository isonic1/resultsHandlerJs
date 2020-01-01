const {promisify} = require('util')
const fs = require('fs');
const fetch = require('node-fetch');
const axios = require('axios')
const tunnel = require('tunnel')
const dateFormat = require('dateformat')

const RETRY_REQUEST_INTERVAL = 500 // ms
const LONG_REQUEST_DELAY_MS = 2000 // ms
const MAX_LONG_REQUEST_DELAY_MS = 10000 // ms
const DEFAULT_TIMEOUT_MS = 300000 // ms (5 min)
const REDUCED_TIMEOUT_MS = 15000 // ms (15 sec)
const LONG_REQUEST_DELAY_MULTIPLICATIVE_INCREASE_FACTOR = 1.5
const DATE_FORMAT_RFC1123 = "ddd, dd mmm yyyy HH:MM:ss 'GMT'"
let counter = 0


const HTTP_STATUS_CODES = {
    CREATED: 201,
    ACCEPTED: 202,
    OK: 200,
    GONE: 410,
    NOT_FOUND: 404,
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    GATEWAY_TIMEOUT: 504,
  }

  const HTTP_FAILED_CODES = [
    HTTP_STATUS_CODES.NOT_FOUND,
    HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR,
    HTTP_STATUS_CODES.BAD_GATEWAY,
    HTTP_STATUS_CODES.GATEWAY_TIMEOUT,
  ]

  const REQUEST_FAILED_CODES = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']

  const DEFAULT_HEADERS = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

class ApplitoolsTestResultHandler {
    constructor(testResult, viewKey, proxyServerUrl, proxyServerPort, proxyServerUsername, proxyServerPassword, isHttpOnly) {
        this.testResult = testResult;
        this.viewKey = viewKey;
        this.testName = this.testName();
        this.appName = this.appName();
        this.viewportSize = this.viewportSize();
        this.hostOS = this.hostingOS();
        this.hostApp = this.hostingApp();
        this.testURL = this.setTestURL();
        this.serverURL = this.setServerURL();
        this.batchId = this.setBatchID();
        this.sessionId = this.setSessionID();
        this.steps = this.steps();
        if (proxyServerUrl != null && proxyServerPort != null){
            this.proxy = this.setProxy(proxyServerUrl, proxyServerPort, proxyServerUsername, proxyServerPassword, isHttpOnly);
        }
        this.httpOptions = {
            proxy: undefined,
            headers: DEFAULT_HEADERS,
            timeout: DEFAULT_TIMEOUT_MS,
            responseType: 'json',
            params: {},
          }
    }

    async stepStatusArray() {
        const results = (await this.getStepResults()).map(obj => obj.status);
        return results;
    }

    async downloadImages(dir, type) {
        if (dir == undefined || !fs.existsSync(dir)) {
            console.log(`Directory was undefined or non-existent. Saving images to: ${process.cwd()}`);
            dir = process.cwd();
        } else {
            console.log(`Saving images to: ${dir}`);
        }

        const imagesDir = await this.directoryCreator(dir);
        const images = await this.getImageUrls(type);
        for (let i = 0, len = images.length; i < len; i++) {
            const fileName = `${imagesDir}/${images[i][0]}`;
            const downloadUrl = images[i][1];
            await this.downloadImage(fileName, downloadUrl);
            console.log(`Image has been saved to: ${fileName}`)
        }
    }

    ///Private Methods

    testValues() {
        //return this.testResult.value_;
        return this.testResult;
    }

    testName() {
        return this.testValues()._name;
    }

    appName() {
        return this.testValues()._appName;
    }

    viewportSize() {
        const width = this.testValues()._hostDisplaySize._width;
        const height = this.testValues()._hostDisplaySize._height;
        return `${width}x${height}`;
    }

    hostingOS() {
        return this.testValues()._hostOS;
    }

    hostingApp() {
        return this.testValues()._hostApp;
    }

    setTestURL() {
        return this.testValues()._appUrls._session;
    }

    setServerURL() {
        return this.testURL.split("/app")[0];
    }

    setBatchID() {
        return this.testValues()._batchId;
    }

    setSessionID() {
        return this.testValues()._id;
    }

    setProxy(uri, proxyServerPort, proxyUsername, proxyPassword, isHttpOnly = false){
        const proxy = {}
        let url = new URL(uri.includes('://') ? uri : `http://${uri}:${proxyServerPort}`)
        proxy.protocol = url.protocol
        proxy.host = url.hostname
        proxy.port = url.port
        proxy.isHttpOnly = !!isHttpOnly
        if (!username && url.username) {
            proxy.auth = {
              username: url.username,
              password: url.password,
            }
          } else if (username) {
            proxy.auth = {
              username: proxyUsername,
              password: proxyPassword,
            }
          }

        return proxy
    }

    steps() {
        return this.testValues()._steps;
    }

    getStepInfo(index) {
        return this.testValues()._stepsInfo[index];
    }

    isTrue(a, b) {
        return !a.some((e, i) => e != b[i]);
    }

    async getStepResults() {
        const stepResults = new Array;
        let status = new String;

        for (let i = 0; i < this.steps; ++i) {
            const isDifferent = this.getStepInfo(i)._isDifferent;
            const hasBaselineImage = this.getStepInfo(i)._hasBaselineImage;
            const hasCurrentImage = this.getStepInfo(i)._hasCurrentImage;

            const bools = [ isDifferent, hasBaselineImage, hasCurrentImage ];

            const isNew     = [ false, false, true  ];
            const isMissing = [ false, true,  false ];
            const isPassed  = [ false, true,  true  ];
            const isUnresolved  = [ true,  true,  true  ];

            if (this.isTrue(isPassed, bools)) {
                status = "PASS"
            }

            if (this.isTrue(isMissing, bools)) {
                status = "MISSING"
            }

            if (this.isTrue(isNew, bools)) {
                status = "NEW"
            }

            if (this.isTrue(isUnresolved, bools)) {
                status = "UNRESOLVED"
            }

            const obj = await this.getSessionDetailsJson()
            const stepInfo = {
                step: i + 1,
                status,
                name: this.getStepInfo(i)._name,
                baselineImageURL: this.getImageUrlByStatus(obj,'baseline'),
                currentImageURL: this.getImageUrlByStatus(obj, 'current'),
                diffImageURL: this.getDiffUrl(status, i + 1)
            };
            stepResults.push(stepInfo);
        }
        return stepResults;
    }


    async getSessionDetailsJson(){
        const URL = `${this.serverURL}/api/sessions/batches/${this.batchId}/${this.sessionId}/?ApiKey=${this.viewKey}`;
        return await fetch(URL)
            .then(res => res.json())
    }

    getSpecificImageUrl(imageId) {
        return `${this.serverURL}/api/images/${imageId}`;
    }

    getSpecificDiffImageUrl(step) {
       return`${this.serverURL}/api/sessions/batches/${this.batchId}/${this.sessionId}/steps/${step}/diff`;
    }

    getImageUrlByStatus(obj, type){
        let UIDS = new Array;;
        if (type == "baseline") {
            UIDS = this.getImageUIDs(obj["expectedAppOutput"]);
        } else if (type == "current") {
            UIDS = this.getImageUIDs(obj["actualAppOutput"]);
        }
        let URL;
        for (let i = 0; i < UIDS.length; i++) {
            if (UIDS[i] == null) {
                URL = null;
            } else {
                URL = this.getSpecificImageUrl(UIDS[i])
            }
        }
        return URL
    }

    getImageUIDs(metadata){
        let retUIDs = new Array;
        for (let i = 0; i < metadata.length; i++) {
            if (metadata[i] == null) {
                retUIDs.push(null);
                // console.log("Broken Json received from the server..")
            } else {
                var entry = metadata[i];
                var image = entry["image"];
                retUIDs.push(image["id"]);
            }
        }
        return retUIDs;
    }

    getDiffUrl(status, step) {
        let diffUrl;
        if (status == 'UNRESOLVED' || status == 'NEW'){
            diffUrl = this.getSpecificDiffImageUrl(step)
        }
        else {
            diffUrl = null
            console.log("No unresolved or new tests found..")
        }
        return diffUrl
    }


    async directoryCreator(path) {
        const dirStructure = [this.testName,this.appName,this.viewportSize,
            this.hostOS,this.hostApp,this.batchId,this.sessionId];

        const currentDir = await process.cwd();
        await process.chdir(path);
        await dirStructure.forEach(dir => {
            if (!fs.existsSync(dir)){
                fs.mkdirSync(dir);
            }
            process.chdir(dir);
        });
        await process.chdir(currentDir);
        return (`${path}/${dirStructure.toString().replace(/,/g, '/')}`);
    }

    validateType(type) {
        const validTypes = ["baseline", "current", "diff"];
        if (validTypes.includes(type)) {
        } else {
            console.log(`Must set a valid type! types: ${validTypes}`)
            process.exit(-1);
        }
    }

    async getImageUrls(type) {
        let images = await this.getStepResults();
        images = await images.map(obj => {
            const fileName = `${obj.step}-${obj.name}-${type}.png`;
            const imagesArray = {
                baseline: [fileName, obj.baselineImageURL],
                current: [fileName, obj.currentImageURL],
                diff: [fileName, obj.diffImageURL]
            };
            return imagesArray
        });

        this.validateType(type);
        const imageUrls = await images.map(obj => {
            if (obj[type][1] != undefined) {
                return obj[type]
            }
        }).filter(n => n != undefined);

        if (imageUrls.length == 0) {
            console.log(`No ${type} images were found. Exiting...`)
            process.exit(-1); 
        }
        return imageUrls;
    }

    async downloadImage(fileName, url) {
        let res;
        try{
             res = await this.sendLongRequest({url});
        }
        catch (e){
            throw new Error(`could not download ${url}: ${e}`)
        }
        const image = await Buffer.from(res.data, 'binary')
        await promisify(fs.writeFile)(fileName, image)
    }

    async sendLongRequest({url}) {
        const options = this.createHttpOptions({
            method: 'GET',
            url,
          })
        const response = await this.sendRequest(options)
        return this.longRequestCheckStatus(response)
      }

    async sendRequest(options, retry = 1, delayBeforeRetry = false) {
        counter += 1
        const requestId = `${counter}--${this.guid()}`
        options.headers['x-applitools-eyes-client-request-id'] = requestId
        try {
          const response = await axios(options)
    
          console.log(
            `[${requestId}] - result ${response.statusText}, status code ${response.status}, url ${options.url}`,
          )
          return response
        } catch (err) {
          const reasonMsg = `${err.message}${err.response ? `(${err.response.statusText})` : ''}`
      
          console.log(
            `ServerConnector[${requestId}] - ${
              options.method
            } request failed. reason=${reasonMsg} | url=${options.url} ${
              err.response ? `| status=${err.response.status} ` : ''
            }| params=${JSON.stringify(options.params).slice(0, 100)}`,
          )
      
          if (err.response && err.response.data) {
            console.log(`ServerConnector - failure body:\n${err.response.data}`)
          }
      
          if (
            retry > 0 &&
            ((err.response && HTTP_FAILED_CODES.includes(err.response.status)) ||
              REQUEST_FAILED_CODES.includes(err.code))
          ) {
            console.log(`ServerConnector retrying request with delay ${delayBeforeRetry}...`)
      
            if (delayBeforeRetry) {
                await new Promise(r => setTimeout(r, RETRY_REQUEST_INTERVAL))
              return this.sendRequest(options, retry - 1, delayBeforeRetry)
            }
      
            return this.sendRequest(options, retry - 1, delayBeforeRetry)
          }
      
          throw new Error(reasonMsg)
        }
    }

    async longRequestCheckStatus(response) {
        switch (response.status) {
          case HTTP_STATUS_CODES.OK: {
            return response
          }
          case HTTP_STATUS_CODES.ACCEPTED: {
            const options = this.createHttpOptions({
              method: 'GET',
              url: response.headers.location,
            })
            const requestResponse = await this.longRequestLoop(options, LONG_REQUEST_DELAY_MS)
            return this.longRequestCheckStatus(requestResponse)
          }
          case HTTP_STATUS_CODES.CREATED: {
            const options = this.createHttpOptions({
              method: 'DELETE',
              url: response.headers.location,
            })
            return this.sendRequest(options)
          }
          case HTTP_STATUS_CODES.GONE: {
            throw new Error('The server task has gone.')
          }
          default: {
            throw new Error(`Unknown error during long request: ${JSON.stringify(response)}`)
          }
        }
      }

      async longRequestLoop(options, delay) {
        delay = Math.min(
          MAX_LONG_REQUEST_DELAY_MS,
          Math.floor(delay * LONG_REQUEST_DELAY_MULTIPLICATIVE_INCREASE_FACTOR),
        )
        console.log(`Still running... Retrying in ${delay} ms`)
      
        await new Promise(r => setTimeout(r, delay))
        const response = await this.sendRequest(options)
        if (response.status !== HTTP_STATUS_CODES.OK) {
          return response
        }
        return longRequestLoop(options, delay)
      }

      createHttpOptions(requestOptions) {
        let options = requestOptions
        options.responseType = 'arraybuffer'
        options.headers = {}
        options.headers['Eyes-Expect'] = '202+location' 
        options.headers['Eyes-Date'] = dateFormat(new Date(), DATE_FORMAT_RFC1123, true) 
       
        options.params = {}
        options.params.apiKey = this.viewKey
        if (this.proxy != null) {
          this.setProxyOptions({options})
        }
        options.maxContentLength = 20 * 1024 * 1024
        return options
      }

      setProxyOptions(options){
        if (!proxy.getIsHttpOnly()) {
            options.proxy = this.proxy
            console.log('using proxy', options.proxy.host, options.proxy.port)
            return
          }
          const proxyObject = this.proxy
          const proxyAuth =
            proxyObject.auth && proxyObject.auth.username
              ? `${proxyObject.auth.username}:${proxyObject.auth.password}`
              : undefined
          const agent = tunnel.httpsOverHttp({
            proxy: {
              host: proxyObject.host,
              port: proxyObject.port || 8080,
              proxyAuth,
            },
          })
          options.httpsAgent = agent
          options.proxy = false // don't use the proxy, we use tunnel.
      }

      guid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          // noinspection MagicNumberJS, NonShortCircuitBooleanExpressionJS
          const r = (Math.random() * 16) | 0 // eslint-disable-line no-bitwise
          // noinspection MagicNumberJS, NonShortCircuitBooleanExpressionJS
          const v = c === 'x' ? r : (r & 0x3) | 0x8 // eslint-disable-line no-bitwise
          return v.toString(16)
        })
    }

    
}

exports.ApplitoolsTestResultHandler = ApplitoolsTestResultHandler;