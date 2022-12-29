#!/usr/bin/env node

const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const prompt = require("prompt-sync")({ sigint: true });

const deploymentDir = process.argv[2];
const is_deploy = String(process.argv[3]).includes("deploy") || !process.argv[3];
const is_gateway = String(process.argv[3]).includes("gateway");

const rel = (relPath) => path.resolve(deploymentDir, relPath);

require("dotenv").config({ path: rel(".env") });

const accessEnv = require("./helpers/accessEnv");

const exec = util.promisify(child_process.exec);

const APPLICATION_NAME = accessEnv("APPLICATION_NAME");
const AWS_REGION = accessEnv("AWS_DEFAULT_REGION");
const AWS_SECRET_ACCESS_KEY = accessEnv("AWS_SECRET_ACCESS_KEY");
const AWS_ACCESS_KEY_ID = accessEnv("AWS_ACCESS_KEY_ID");
const PORT = accessEnv("PORT", 3000);
const DB_NAME = accessEnv("DB_NAME", false);
const DB_USER = accessEnv("DB_USER", false);
const DB_PASSWORD = accessEnv("DB_PASSWORD", false);

const readEnvVars = () => fs.readFileSync(rel(".env"), "utf-8").split(os.EOL);

const setEnvValue = (key, value) => {
  const envVars = readEnvVars();
  const targetLine = envVars.find((line) => line.split("=")[0] === key);
  if (targetLine !== undefined) {
    // update existing line
    const targetLineIndex = envVars.indexOf(targetLine);
    // replace the key/value with the new value
    envVars.splice(targetLineIndex, 1, `${key}="${value}"`);
  } else {
    // create new key value
    envVars.push(`${key}="${value}"`);
  }
  // write everything back to the file system
  fs.writeFileSync(rel(".env"), envVars.join(os.EOL));
};

const getTfStateOutputs = async () => {
  const tfFilePath = rel("./terraform/terraform.tfstate");
  console.log('Running "terraform init"...');
  await exec("terraform init", { cwd: rel("./terraform") });
  console.log('Running "terraform get -update"...');
  await exec("terraform get -update", { cwd: rel("./terraform") });
  console.log('Running "terraform plan"...');
  await exec(
    `terraform plan \
        -var 'aws-region=${AWS_REGION}' \
        -var 'aws-access-key=${AWS_ACCESS_KEY_ID}' \
        -var 'aws-secret-key=${AWS_SECRET_ACCESS_KEY}' \
        -var 'app-name=${APPLICATION_NAME}' \
        -var 'container-port=${PORT}' \
        ${DB_NAME ? "-var 'service-db-name=" + DB_NAME + "'" : ""} \
        ${DB_USER ? "-var 'service-db-username=" + DB_USER + "'" : ""} \
        ${DB_PASSWORD ? "-var 'service-db-password=" + DB_PASSWORD + "'" : ""} \
        -out=PLAN`,
    { cwd: rel("./terraform") }
  );
  console.log('Running "terraform apply"...');
  await exec("terraform apply PLAN", { cwd: rel("./terraform") });

  console.log("Success! Removing PLAN file...");
  fs.unlinkSync(rel("./terraform/PLAN"));

  console.log("Reading terraform.tfstate file...");
  const { outputs } = JSON.parse(fs.readFileSync(tfFilePath, "utf-8"));
  if (!outputs) {
    console.error("No outputs found in terraform.tfstate file!");
    process.exit();
  }
  console.log("Checking for DB_HOST in .env file...");
  const DB_HOST = accessEnv("DB_HOST", false);
  if (DB_HOST !== outputs["service-db-address"] && outputs["service-db-address"] !== "") {
    console.log("Updating .env file with new DB_HOST...");
    setEnvValue("DB_HOST", outputs["service-db-address"].value);
  }
  return outputs;
};

const set_service_dns_url = async () => {
  const ecs_service_list = await exec(`aws elbv2 describe-load-balancers --output json`, {
    cwd: deploymentDir,
  });
  if (ecs_service_list.stderr) {
    console.error(ecs_service_list.stderr);
    process.exit();
  }
  console.log("Setting environment variables... Service URL's:");
  for (lb of JSON.parse(ecs_service_list.stdout).LoadBalancers) {
    console.log(
      lb.LoadBalancerName.split("-")[0].toLocaleUpperCase() + "_SERVICE_URL=http://" + lb.DNSName
    );
    setEnvValue(
      lb.LoadBalancerName.split("-")[0].toLocaleUpperCase() + "_SERVICE_URL",
      "http://" + lb.DNSName
    );
  }
};

(async () => {
  console.time("Running time");
  const outputs = await getTfStateOutputs();
  if (is_gateway) await set_service_dns_url();

  if (!is_deploy) {
    console.log("Deploy command not found. Process finished!");
    process.exit();
  }
  console.log("Deploying in 3 seconds...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const lockFilePath = rel("deploy.lock");
  console.log("Checking for lockfile...");
  if (fs.existsSync(lockFilePath)) {
    console.error("Lockfile deploy.lock found!");
    const answer = prompt("Do you want to continue? ");
    if (answer.toLocaleLowerCase() != "y" && answer.toLocaleLowerCase() != "yes") {
      console.error("Halting...");
      process.exit();
    }
  }

  console.log("Creating lockfile...");
  fs.writeFileSync(
    lockFilePath,
    "This stops node-deploy from running concurrently with itself. Remove this if node-deploy complains."
  );

  console.log("Deploying application...");

  await exec(
    `aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${
      outputs["ecr-repository-url"].value.split("/")[0]
    }`,
    { cwd: deploymentDir }
  );

  console.log("Building Docker image...");
  await exec(
    `docker build --build-arg arch=amd64 --build-arg PORT=${PORT} -t yemctech-${APPLICATION_NAME} .`,
    {
      cwd: deploymentDir,
    }
  );
  await exec(
    `docker tag yemctech-${APPLICATION_NAME}:latest ${outputs["ecr-repository-url"].value}:latest`,
    {
      cwd: deploymentDir,
    }
  );

  console.log("Deployment initiated on Docker Deploy!");
  await exec(`docker push ${outputs["ecr-repository-url"].value}:latest`, {
    cwd: deploymentDir,
  });

  console.log("Force new deployment on ECS!");
  await exec(
    `aws ecs update-service --cluster ${outputs["ecs_cluster_name"].value} --service ${outputs["ecs_service_name"].value} --force-new-deployment --region ${AWS_REGION}`,
    { cwd: deploymentDir }
  );

  console.log("Cleaning up...");
  console.log("load-balancer-dns: ", outputs["alb-dns"].value);
  fs.unlinkSync(rel("deploy.lock"));
  console.timeEnd("Running time");
  console.log("Finish Date: ", new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }));
})();
