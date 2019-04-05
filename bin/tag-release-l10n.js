#!/usr/bin/env node
/* eslint-disable max-statements */
const commander = require("commander");
const api = require("../src/index.js");
const { sync, check: checkFlow } = require("../src/workflows/l10n");
const qaAuto = require("../src/workflows/qa-automated");
const utils = require("../src/utils.js");
const steps = require("../src/workflows/steps/index");
const { remove, findIndex, clone, map, filter, forEach } = require("lodash");
const Table = require("cli-table2");
const path = require("path");
const { rootDirectory, l10n = [] } = require(path.join(
	process.env.TR_DIRECTORY,
	"./.tag-releaserc.json"
));
let preReleaseFlow = require("../src/workflows/pre-release");
const filterFlowBasedOnDevelopBranch = require("../src/helpers/filterFlowBasedOnDevelopBranch");
const runWorkflow = require("../src/helpers/runWorkflow");
const ora = require("ora");
const chalk = require("chalk");

process.env.NO_OUTPUT = true;

utils.applyCommanderOptions(commander);
commander.option(
	"--check",
	"check if there are changes in the repos before you actually run the tool"
);

commander.parse(process.argv);

const { verbose, maxbuffer, check } = commander;

const hasChanges = options => options.changes.locale || options.changes.dev;

const saveState = (options, item) => {
	const { repo } = item.value;
	options.l10n.push({
		repo,
		branch: options.branch,
		tag: options.tag,
		status: options.status,
		host: options.host,
		changes: options.changes
	});
};

const getNextState = (options, item, callback) => {
	options.tag = "";
	options.status = "pending";
	options.changes = {
		locale: false,
		dev: false
	};
	options.callback = callback;
	options.stashed = "";

	if (!item.done) {
		const { branch, repo, host } = item.value;
		options.branch = branch;
		options.cwd = `${rootDirectory}/${repo}`;
		options.spinner = ora(repo);
		options.host = host;
		options.repo = repo;
	}
};

const statusColors = {
	"no changes": status => chalk.blue(status),
	changes: status => chalk.yellow(status),
	"pre-released": status => chalk.yellow(status),
	"qa bumped": status => chalk.yellow(status),
	"up-to-date": status => chalk.green(status),
	skipped: status => chalk.red(status),
	default: status => chalk.yellow(status)
};
const getStatusColor = status => {
	let color = statusColors[status];
	if (!color) {
		color = statusColors.default;
	}
	return color(status);
};

const iterator = l10n[Symbol.iterator]();
let item = iterator.next();
const callback = async options => {
	let flow;
	if (hasChanges(options)) {
		await steps.checkoutl10nBranch(options);

		// if the branch already existed, we need to just skip the release.
		if (options.status !== "skipped") {
			// check if we are dealing with a private repo (host project)
			if (!utils.isPackagePrivate(options.configPath)) {
				// remove steps that aren't required for automated run
				preReleaseFlow = remove(preReleaseFlow, step => {
					return (
						step !== steps.previewLog &&
						step !== steps.gitDiff &&
						step !== steps.gitMergeUpstreamBranch
					);
				});

				options.callback = () => Promise.resolve();
				flow = filterFlowBasedOnDevelopBranch(options, preReleaseFlow);
				await runWorkflow(flow, options);
				options.status = "pre-released";
			}
		}
	}

	// reset if we stashed during the syncing
	await steps.resetIfStashed(options);

	saveState(options, item);
	options.spinner.succeed(item.value.repo);

	item = iterator.next();
	getNextState(options, item, callback);
	if (item.done) {
		// check if any repos were private
		const privateIndex = findIndex(options.l10n, { host: true });
		if (
			privateIndex !== -1 &&
			options.l10n[privateIndex].status !== "skipped"
		) {
			const { repo: pRepo } = options.l10n[privateIndex];
			let l10nClone = clone(options.l10n);
			l10nClone = filter(l10nClone, i => {
				return !i.host && i.tag;
			});
			options.dependencies = map(l10nClone, dep => {
				return {
					pkg: dep.repo,
					version: dep.tag.substr(
						dep.tag.indexOf("v") + 1,
						dep.tag.length
					)
				};
			});

			// if it has dependencies, then we need to QA bump
			// else display if host project has changes or up-to-date
			if (options.dependencies && options.dependencies.length > 0) {
				options.spinner = ora("creating qa branch").start();
				options.repo = pRepo;
				options.cwd = `${rootDirectory}/${pRepo}`;
				options.changeReason = "Updated l10n translations".replace(
					/["]+/g,
					""
				);
				options.callback = () => {};

				await runWorkflow(qaAuto, options);
				options.l10n[privateIndex].status = "qa bumped";
				options.spinner.succeed("creating qa branch");
			} else if (hasChanges(options.l10n[privateIndex])) {
				options.l10n[privateIndex].status = "changes";
			} else {
				options.l10n[privateIndex].status = "up-to-date";
			}
		}

		const table = new Table({
			head: ["repo", "branch", "tag", "status"]
		});
		forEach(options.l10n, ({ repo, branch, tag, status }) => {
			table.push([repo, branch, tag, getStatusColor(status)]);
		});
		console.log(table.toString()); // eslint-disable-line no-console

		return Promise.resolve();
	}

	options.spinner.start();
	flow = filterFlowBasedOnDevelopBranch(options, sync);

	return runWorkflow(flow, options);
};

const dry = options => {
	saveState(options, item);
	options.spinner.succeed(item.value.repo);

	item = iterator.next();
	getNextState(options, item, dry);
	if (item.done) {
		const table = new Table({
			head: ["repo", "branch", "dev keys", "locale keys", "log diff"]
		});
		forEach(
			options.l10n,
			({ repo, branch, changes: { locale, dev, diff } }) => {
				const message = `${diff ? `${diff} commit(s)` : "up-to-date"}`;
				const devChanges = dev ? "changes" : "no changes";
				const localeChanges = locale ? "changes" : "no changes";
				table.push([
					repo,
					branch,
					getStatusColor(devChanges),
					getStatusColor(localeChanges),
					getStatusColor(message)
				]);
			}
		);
		console.log(table.toString()); // eslint-disable-line no-console

		return Promise.resolve();
	}

	options.spinner.start();
	return runWorkflow(checkFlow, options);
};

const { branch, repo, host } = item.value;
const today = new Date();
const currentMonth = today
	.toLocaleString("en-us", { month: "short" })
	.toLowerCase();
const options = {
	verbose,
	maxbuffer,
	workflow: check ? checkFlow : sync,
	cwd: `${rootDirectory}/${repo}`, // directory to be running tag-release in (cwd-current working directory)
	branch,
	callback: check ? dry : callback,
	command: "l10n",
	prerelease: `l10n-${currentMonth}-${today.getDate()}`, // used for pre-release identifier
	release: "preminor", // used for release type,
	releaseName: "Updated l10n translations", // name to be used for pre-release,
	status: "pending",
	host,
	repo,
	spinner: ora(repo),
	l10n: [],
	changes: {
		locale: false,
		dev: false,
		diff: 0
	}
};

options.spinner.start();
api.cli(options);
