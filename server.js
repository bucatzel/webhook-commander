var config = require('./config.json');
var commands = require('./commands.json');
var express = require('express');
var bodyParser = require('body-parser');
var Client = require('node-rest-client').Client;
var client = new Client();
var async = require('async');
var fs = require('fs');
var path = require('path');
var logStream = config.log && fs.createWriteStream(config.log);
const exec = require('child_process').exec;
const execSync = require('child_process').execSync;
var rimraf = require('rimraf');

var GithubWebHook = require('express-github-webhook');
var webhookHandler = GithubWebHook({path: config.github.path, secret: config.github.secret});

if (config.slack.use) {
    var Slack = require('slack-node');
    var slack = new Slack();
    slack.setWebhook(config.slack.webhookUrl);
}

if (config.skype.use) {
    var SkypeWebApi = require('skype-web-api')
    const skypeApi = new SkypeWebApi();
}

if (config.mail.use) {
    const nodemailer = require("nodemailer");
    let transporter = nodemailer.createTransport(config.mail.credentials)
}
var queueReq = {};

commands.rules.forEach(function (rule) {
    queueReq[rule.reponame] = async.queue(function (data, callback) {
        data.timeStarted = Date.now().toString();
        beforeMsg(data);
        let deployCmdList = rule.precommands;
        if (rule.deploy) {
            let deployPaths = {
                repoDir: path.join(rule.workspace, 'repo', '/'),
                releaseDir: path.join(rule.workspace, 'releases', '/'),
                nextReleaseDir: path.join(rule.workspace, 'releases', data.timeStarted, '/')
            };
            deployCmdList = deployCmdList.concat(deployInit(deployPaths));
            deployCmdList = deployCmdList.concat(deployCheckout(deployPaths, data));
            deployCmdList = deployCmdList.concat(deployPrepare(deployPaths, rule.deploycommands));
            deployCmdList = deployCmdList.concat(deploySwitch(deployPaths, rule));
        }
        var syncCommands = deployCmdList.map(function (command) {
            return execSync(command);
        });

        deployCmdList = deployCmdList.concat(rule.postcommands);
        //
        // var promises = deployCmdList.map(function (command) {
        //     return executeCmd(command);
        // });
        //
        // Promise.all(promises)
        //     .then(function () {
        //         // All tasks are done now
        //         deployCleanup(deployPaths);
        //
        //         afterMsg(data);
        //
        //         //Log stats
        //         logStream.write('Waited to start ' + (data.timeStarted - data.timeReceived) + ' ms\n');
        //         logStream.write('Processed in    ' + (Date.now() - data.timeStarted) / 1000 + ' s\n');
        //         logStream.write('Total time      ' + (Date.now() - data.timeReceived) / 1000 + ' s\n');
        //
        //         callback();
        //     })
        //     .catch(console.error);

    }, 1);
});


// use in your express app
let app = express();
app.set('port', config.port || 9000);
app.set('rules', commands.rules || {});
app.listen(app.get('port'));

app.use(bodyParser.json()); // must use bodyParser in express
app.use(webhookHandler); // use our middleware

// Now could handle following events
webhookHandler.on('*', function (event, repo, data) {
    commands.rules.forEach(function (rule) {
        if (event === rule.event && repo === rule.reponame && data.ref === rule.ref) {
            console.log('Starting event triggered by ' + data.commits[0].author.name);
            data.timeReceived = Date.now();
            queueReq[rule.reponame].push(data, function (err) {
                if (err) {
                    console.error("webhookHandler queue error: ", err);
                }
                console.log('Finished event triggered by ' + data.commits[0].author.name);
            });
        } else {
            console.log("webhookHandler not covered by rules: ", event, repo, data.ref);
        }
    });
});

webhookHandler.on('error', function (err, req, res) {
    console.error("webhookHandlerError: ", err, req, res);
});

function beforeMsg(data) {
    newrelicMsg(data, "START");
    console.log("STARTED:" + data.timeStarted);
}

function afterMsg(data) {
    newrelicMsg(data, "FINISH");

    slackMsg(data);
    console.log("FINISHED:" + data.timeStarted);
}

function newrelicMsg(data, message) {
    if (config.newrelic.applicationID.length > 0) {
        var args = {
            data: {
                "deployment": {
                    "revision": data.commits[0].id,
                    "changelog": data.commits[0].message,
                    "description": message,
                    "user": data.commits[0].author.name
                }
            },
            headers: {
                "Content-Type": "application/json",
                "X-Api-Key": config.newrelic.apiKey
            }
        };

        client.post("https://api.newrelic.com/v2/applications/" + config.newrelic.applicationID + "/deployments.json", args, function (data, response) {
            // parsed response body as js object
            //console.log(data);
            // raw response
            //console.log(response);
        });
    }
}

function slackMsg(data) {
    if (config.slack.use) {

        slack.webhook({
            channel: config.slack.channel,
            username: config.slack.username,
            text: "`" + data.commits[0].id.substr(0, 6) + "` by " + data.commits[0].author.name + "\n ```" + data.commits[0].message + "``` processed"
        }, function (err, response) {
        });
    }
}

function skypeMsg(data) {
    if (config.skype.use) {
        //text: "`" + data.commits[0].id.substr(0,6) + "` by " + data.commits[0].author.name + "\n ```" + data.commits[0].message + "``` processed"
    }
}

function mailMsg(data) {
    if (config.mail.use) {
        var message = {
            from: config.mail.from,
            to: config.mail.to,
            subject: "Message title",
            text: "`" + data.commits[0].id.substr(0, 6) + "` by " + data.commits[0].author.name + "\n ```" + data.commits[0].message + "``` processed",
            html: "<p>HTML version of the message</p>"
        };
        transporter.sendMail(message);
        //text:
    }
}

function deployInit(deployPaths ) {
    let a = [];
    if (config.deploy.use) {
        a.push("mkdir -p " + deployPaths.repoDir);
        a.push("mkdir -p " + deployPaths.nextReleaseDir);
    }
    return a;
}

function deployCheckout(deployPaths, data) {
    let a = [];
    if (config.deploy.use) {
        if (!fs.existsSync(path.join(deployPaths.repoDir, '.git'))) {
            a.push("git clone " + config.deploy.repository + " " + deployPaths.repoDir);
        }
        a.push("cd  " + deployPaths.repoDir + " && git checkout " + data.commits[0].id);
        a.push("rsync -avhe " + config.deploy.exclude.map(function (item) {
            return " --exclude " + path.join(deployPaths.repoDir, item)
        }) + " " + deployPaths.repoDir + " " + deployPaths.nextReleaseDir);
    }
    return a;
}

function deployPrepare(deployPaths, commands) {
    let a = [];
    if (config.deploy.use) {
        if (commands.length) {
            a = commands.map(function (command) {
                return "cd  " + deployPaths.nextReleaseDir + " && " + command;
            });

        }
    }
    return a;
}

function deploySwitch(deployPaths, rule) {
    let a = [];
    a.push("ln -s " + deployPaths.nextReleaseDir + " " + rule.deployTo)
    return a;
}

function deployCleanup(deployPaths) {
    fs.readdir(deployPaths.releaseDir, (error, folders) => {
        if (folders.length > config.deploy.keepReleases) {
            //delete the oldest
            let oldestReleaseDir = path.join(deployPaths.nextReleaseDir, Math.min.apply(null, folders));
            if (fs.existsSync(oldestReleaseDir)) {
                rimraf(oldestReleaseDir, function (e) {

                    console.log(e);
                    console.log('Older release folder deleted');

                });
            }
        }

    });
}

function executeCmd(command) {
    return new Promise((resolve, reject) => {
        exec(command, {maxBuffer: 1024 * 1024 * 10}, (error, stdout, stderr) => {
            logStream.write(command + '\n');
            console.log(command);
            if (error) {
                reject(stderr);
            } else {
                logStream.write(stdout + '\n');

                resolve(stdout);
            }
        });
    });
}
