const {promisify} = require('util')
const fs = require('fs');
const https = require('https');
const fetch = require('node-fetch');
const Stream = require('stream').Transform

class ApplitoolsTestResultHandler {
    constructor(testResult, viewKey) {
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
        return `${this.serverURL}/api/images/${imageId}?apiKey=${this.viewKey}`;
    }

    getSpecificDiffImageUrl(step) {
       return`${this.serverURL}/api/sessions/batches/${this.batchId}/${this.sessionId}/steps/${step}/diff?ApiKey=${this.viewKey}`;
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
                // console.log("Bad image URL received")
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
            process.exit(-1); //Maybe return on this instead. Could exit out of script premature.
        }
        return imageUrls;
    }

    async downloadImage(fileName, url) {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`could not download ${url}: ${res.status}`)
        }
        const image = await res.buffer()
        await promisify(fs.writeFile)(fileName, image)
    }
}

exports.ApplitoolsTestResultHandler = ApplitoolsTestResultHandler;