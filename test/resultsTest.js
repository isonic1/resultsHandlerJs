const assert = require('assert');
const {Builder, By, promise, until} = require('selenium-webdriver');
const {Eyes, Target} = require('@applitools/eyes-selenium');
var ConsoleLogHandler = require('@applitools/eyes-selenium').ConsoleLogHandler;
var ApplitoolsTestResultHandler = require('../applitoolsTestHandler').ApplitoolsTestResultHandler;
promise.USE_PROMISE_MANAGER = false;

describe('Simple Test', function() {
    let driver;
    let eyes;

    beforeEach(async function() {
        eyes = new Eyes();
        eyes.setLogHandler(new ConsoleLogHandler(true));
        eyes.setApiKey("YOUR_API_KEY");
        driver = await new Builder().forBrowser('chrome').build();
    });

    afterEach(async function() {
        await driver.quit();

    });

    it('Results Handler test', async function() {

        var applitoolsViewKey = 'YOUR_VIEW_KEY'
        let downloadPath = process.cwd()+'/downloadImages'
        var downloadDir = downloadPath

        await eyes.open(driver, 'Google Page', 'GoogleTestPage', {width: 1000, height: 700});

        await driver.get("http://the-internet.herokuapp.com/dynamic_content");

        await eyes.checkWindow("landingPage");

        let results = await eyes.close(false);

        const handler = new ApplitoolsTestResultHandler(results, applitoolsViewKey);
        await handler.downloadImages(downloadDir, 'current'); //valid types = baseline, current, diff

        let testStatus = handler.stepStatusArray();
        console.log("My Test Status: " + testStatus);
    });
});