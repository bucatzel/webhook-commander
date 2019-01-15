	var options = require('./config.prod.json');
	var express = require('express');
	var bodyParser = require('body-parser');
	var Client = require('node-rest-client').Client;
	var client = new Client();
	var async = require('async');
	var fs            = require('fs');
	var logStream = options.log && fs.createWriteStream(options.log);
	const exec = require('child_process').exec;

	var GithubWebHook = require('express-github-webhook');
	var webhookHandler = GithubWebHook({ path: options.github.path, secret: options.github.secret });

	var Slack = require('slack-node');
	var slack = new Slack();

	var queueReq = {};

	options.rules.forEach(function(rule){
		queueReq[rule.reponame] = async.queue(function(data, callback) {
			data.timeStarted = Date.now();
			beforeMsg(data);
			var promises = rule.commands.map(function(command){
				return executeCmd(command);
			});

			Promise.all(promises)
			.then(function() {
				// All tasks are done now
				afterMsg(data);

				//Log stats
				logStream.write('Waited to start ' + (data.timeStarted - data.timeReceived) + ' ms\n');
				logStream.write('Processed in    ' + (Date.now() - data.timeStarted)/1000 + ' s\n');
				logStream.write('Total time      ' + (Date.now() - data.timeReceived)/1000 + ' s\n');

				callback();
			})
			.catch(console.error);

		}, 1);
	});


	// use in your express app
	let app = express();
	app.set('port', options.port || 9000);
	app.set('rules', options.rules || {});
	app.listen(app.get('port'));

	app.use(bodyParser.json()); // must use bodyParser in express
	app.use(webhookHandler); // use our middleware

	// Now could handle following events
	webhookHandler.on('*', function (event, repo, data){
		options.rules.forEach(function(rule){
			if(event === rule.event && repo === rule.reponame && data.ref === rule.ref){
				console.log('Starting deploy triggered by ' + data.commits[0].author.name);
				data.timeReceived = Date.now();
				queueReq[rule.reponame].push(data, function (err) {
					if(err){
						console.error("webhookHandler queue error: ", err);
					}
					console.log('Finished deploy triggered by ' + data.commits[0].author.name);
				});
			} else {
				console.log("webhookHandler not covered by rules: ", event, repo, data.ref);
			}
		});
	});

	webhookHandler.on('error', function (err, req, res) {
		console.error("webhookHandlerError: ", err, req, res);
	});

	function beforeMsg (data) {
		newrelicMsg (data, "START");
		console.log("STARTED:" + data.timeStarted);
	}

	function afterMsg (data) {
		newrelicMsg (data, "FINISH");

		slackMsg (data);
		console.log("FINISHED:" + data.timeStarted);
	}

	function newrelicMsg (data, message) {
		if(options.newrelic.applicationID.length > 0){
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
					"X-Api-Key":options.newrelic.apiKey
				}
			};

			client.post("https://api.newrelic.com/v2/applications/" + options.newrelic.applicationID + "/deployments.json", args, function (data, response) {
				// parsed response body as js object
				//console.log(data);
				// raw response
				//console.log(response);
			});
		}
	}

	function slackMsg (data) {
		if(options.slack.webhookUrl.length > 0){

			slack.setWebhook(options.slack.webhookUrl);

			slack.webhook({
					channel: options.slack.channel,
					username: options.slack.username,
					text: "`" + data.commits[0].id.substr(0,6) + "` by " + data.commits[0].author.name + "\n ```" + data.commits[0].message + "``` deployed"
				}, function(err, response) {
				//console.log(response);
			});
		}
	}

	function executeCmd(command) {
		return new Promise((resolve, reject) => {
            exec(command,{ maxBuffer: 1024 * 1024 * 10},(error, stdout, stderr) => {
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
