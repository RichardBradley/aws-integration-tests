import {APIGatewayClient, GetRestApisCommand} from "@aws-sdk/client-api-gateway";
import {ApiGatewayV2Client, GetApisCommand} from "@aws-sdk/client-apigatewayv2";
import {CloudFrontClient, ListDistributionsCommand} from "@aws-sdk/client-cloudfront";
import {CloudWatchClient, Dimension, MetricAlarm, paginateDescribeAlarms} from "@aws-sdk/client-cloudwatch";
import {DynamoDBClient, ListTablesCommand} from "@aws-sdk/client-dynamodb";
import {DescribeTargetGroupsCommand, ElasticLoadBalancingV2Client} from "@aws-sdk/client-elastic-load-balancing-v2";
import {EventBridgeClient, ListRulesCommand} from "@aws-sdk/client-eventbridge";
import {DescribeDBInstancesCommand, RDSClient} from "@aws-sdk/client-rds";
import {ListQueuesCommand, SQSClient} from "@aws-sdk/client-sqs";
import "fs/promises";
import isEqual from "lodash/isEqual";
import * as fs from "node:fs";
import * as console from "node:console";
import * as JSON5 from "json5";
import "should";

describe("cloudwatch alarms", async () => {

    it("should have all alarms point to known metrics and dimensions", async function () {
        this.timeout(300000);
        const client = new CloudWatchClient({});

        const alarms = await withFileCache("describeAlarms_MetricAlarms.json", async () => {
            const acc: MetricAlarm[] = []
            const paginator = paginateDescribeAlarms({client}, {});
            for await (const page of paginator) {
                acc.push(...(page.MetricAlarms || []));
            }

            // We remove "-test-" here so that we only look at "-int-" alarms on CI
            // to avoid reporting the same error twice, and so devs can fix on int
            // and see this test go green without needing to release twice
            return acc.filter(a => !a.AlarmName?.includes("-test-"));
        });

        console.log(`${alarms.length} alarms found, checking each...`);

        const errors: unknown[] = [];
        for (let alarm of alarms) {
            try {
                await checkAlarmMetricsAndDimensions(alarm)
            } catch (e) {
                const msg = (e instanceof Error) ? e.stack : e!.toString();
                errors.push(`For alarm ${alarm.AlarmName}: ${msg}`)
            }
        }
        console.log(errors)
        errors.should.be.empty()
    })

    async function withFileCache<T>(filename: string, fetcher: () => Promise<T>): Promise<T> {
        const cacheDir = ".cache";
        fs.mkdirSync(cacheDir, {recursive: true})
        const cacheFile = `${cacheDir}/${filename}`
        if (isFileRecent(cacheFile)) {
            return JSON5.parse(fs.readFileSync(cacheFile, 'utf-8'));
        }
        const data = await fetcher();
        fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
        return data;
    }

    function isFileRecent(filePath: string) {
        if (!fs.existsSync(filePath)) {
            return false;
        }
        const stats = fs.statSync(filePath);
        if (!stats) {
            return false;
        }
        const lastModified = stats.mtime;
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000; // 24 hours in milliseconds

        return lastModified.getTime() > oneDayAgo;
    }


    async function checkAlarmMetricsAndDimensions(a: MetricAlarm) {
        if (a.Namespace === undefined) {
            // multi-metric alarm, not easy to check
            return;
        }

        switch (a.Namespace) {
            case "AWS/DynamoDB":
                // See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html
                switch (a.MetricName) {
                    case "ConsumedWriteCapacityUnits":
                    case "ConsumedReadCapacityUnits":
                        // https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/metrics-dimensions.html#ConsumedWriteCapacityUnits
                        a.Dimensions?.map(d => d.Name).should.deepEqual(["TableName"])
                        await assertDynamoDbTableNameExists(a.Dimensions![0].Value!)
                        break;

                    case "SystemErrors":
                        // This is not a useful metric, as it is emitted only for the
                        // dimension [TableName, Operation], so you would have to create
                        // it once for each possible operation.
                        //
                        // I have confirmed this with AWS support.
                        a.Dimensions?.map(d => d.Name).sort().should.deepEqual(["TableName", "Operation"])

                        break;
                    default:
                        throw new Error("Unhandled MetricName: " + a.MetricName);
                }
                break;
            case "AWS/CloudFront":
                // See https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/programming-cloudwatch-metrics.html
                // See comment on Region dimension on DDoSProtection
                a.Dimensions?.map(d => d.Name).sort().should.deepEqual(["DistributionId", "Region"])
                await assertCloudFrontDistroExists(a.Dimensions![0].Value!)

                switch (a.MetricName) {
                    case "4xxErrorRate":
                    case "5xxErrorRate":

                        a.Statistic!.should.equal("Average")

                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;

            case "AWS/S3":
                // See https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html

                switch (a.MetricName) {
                    case "5xxErrors":
                    case "AllRequests":
                        // Inspected in metrics -- "0" was emitted here
                        a.Dimensions?.map(d => d.Name).sort().should.deepEqual(["BucketName", "FilterId"])

                        a.Statistic!.should.equal("Sum")

                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/ApiGateway":
                // This same namespace is used for v1 (REST) and v2 (HTTP), but different dimensions
                // and metrics appear!
                // This is a source of bugs, check carefully
                //
                // v1:
                // See https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html
                // v2:
                // See https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html
                if (isEqual(["ApiName"], a.Dimensions?.map(d => d.Name))) {
                    // v1
                    a.MetricName!.should.equalOneOf("4XXError", "5XXError", "Latency")
                    await assertApiRestGatewayExists(a.Dimensions![0].Value!)

                    if (a.MetricName!.includes("XX")) {
                        a.Statistic!.should.equal("Sum")
                    }
                } else if (isEqual(["ApiId"], a.Dimensions?.map(d => d.Name))) {
                    // v2
                    a.MetricName!.should.equalOneOf("4xx", "5xx", "Latency")
                    await assertApiHttpGatewayExists(a.Dimensions![0].Value!)

                    if (a.MetricName!.includes("xx")) {
                        a.Statistic!.should.equal("Sum")
                    }
                } else {
                    throw new Error("Unhandled or incorrect Dimensions: " + JSON.stringify(a.Dimensions));
                }
                break;
            case "AWS/RDS":
                // See https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/dimensions.html
                a.Dimensions?.map(d => d.Name).should.deepEqual(["DBInstanceIdentifier"])
                await assertDBInstanceIdentifierExists(a.Dimensions![0].Value!)

                // https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-metrics.html
                switch (a.MetricName) {
                    case "CPUUtilization":
                    case "FreeStorageSpace":
                        // ok
                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/SQS":
                // See https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html
                a.Dimensions?.map(d => d.Name).should.deepEqual(["QueueName"])
                await assertSQSQueueNameExists(a.Dimensions![0].Value!)

                switch (a.MetricName) {
                    case "ApproximateAgeOfOldestMessage":
                    case "ApproximateNumberOfMessagesVisible":
                        // ok
                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/ApplicationELB":
                // See https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html

                switch (a.MetricName) {
                    case "HTTPCode_Target_4XX_Count":
                    case "HTTPCode_Target_5XX_Count":
                    case "HealthyHostCount":
                    case "UnHealthyHostCount":
                        a.Dimensions?.map(d => d.Name).sort().should.deepEqual(["LoadBalancer", "TargetGroup"])
                        await assertTargetGroupExists(getDim(a.Dimensions!, "LoadBalancer"), getDim(a.Dimensions!, "TargetGroup"))

                        if (a.MetricName.includes("XX")) {
                            // From the docs for HTTPCode_Target_4XX_Count, HTTPCode_Target_5XX_Count:
                            //   Statistics: The most useful statistic is Sum. Minimum, Maximum, and Average all return 1.
                            a.Statistic!.should.equal("Sum")
                        }

                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/DDoSProtection":
                // See https://docs.aws.amazon.com/waf/latest/developerguide/shield-metrics.html

                switch (a.MetricName) {
                    case "DDoSDetected":
                        if (a.Dimensions?.length == 1) {
                            a.Dimensions?.map(d => d.Name).sort().should.deepEqual(["ResourceArn"])
                        } else {
                            // This is weird -- the API reports that the dimensions include Region, but
                            // the Cloudwatch UI doesn't show this dimension, either on the alarm or on the metric.
                            // It seems likely that this is some weird artifact of a cross-region API call.
                            // I have checked some alarms at the time of writing, including "ierds-int-frontend_assets-DDoSDetected",
                            // and they do appear to be correctly configured and pointing at a metric which does emit 0
                            a.Dimensions?.map(d => d.Name).sort().should.deepEqual(['Region', 'ResourceArn'])
                        }
                        // We don't check here that the alarm is pointing to a real resource, because
                        // there are several kinds of resources here and it would be cumbersome to add
                        // each type of check.
                        // We do construct the Shield check from the same resource arn
                        // in infrastructure/shield-protection/shield-protection.tf
                        // and I have checked a couple of those at the time of writing
                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/Events":
                // See https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-monitoring.html
                switch (a.MetricName) {
                    case "TriggeredRules":
                        // The docs say the dimensions are "EventBusName, None, RuleName"
                        // It's not clear to me quite what that means
                        // By observation, the "TriggeredRules" metric is emitted with a single
                        // dimension of "RuleName" for our custom rules that look for container-exited
                        a.Dimensions?.map(d => d.Name).should.deepEqual(["RuleName"])
                        await assertEventRuleExists(a.Dimensions![0].Value!)

                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/NetworkELB":
                // See https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-cloudwatch-metrics.html
                switch (a.MetricName) {
                    case "HealthyHostCount":
                        a.Dimensions?.map(d => d.Name).sort().should.deepEqual(["LoadBalancer", "TargetGroup"])
                        await assertTargetGroupExists(getDim(a.Dimensions!, "LoadBalancer"), getDim(a.Dimensions!, "TargetGroup"))
                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/SNS":
                // See https://docs.aws.amazon.com/sns/latest/dg/sns-monitoring-using-cloudwatch.html
                switch (a.MetricName) {
                    case "NumberOfNotificationsFailed":
                        // The docs here do say "Valid statistics: Sum, Average"
                        // but based on the rest of the description, I don't think Average
                        // would work:
                        //   "For SMS ... the metric increments by 1 when Amazon SNS stops attempting message deliveries."
                        a.Statistic!.should.equal("Sum")
                        a.Dimensions?.map(d => d.Name).should.deepEqual(["PhoneNumber"])
                        break;
                    case "SMSMonthToDateSpentUSD":
                        // ok
                        // docs: "Valid statistics: Sum"
                        a.Statistic!.should.equal("Sum")
                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);
                }
                break;
            case "AWS/Backup":
                // See https://docs.aws.amazon.com/aws-backup/latest/devguide/cloudwatch.html
                // dimensions are not clearly defined there
                switch (a.MetricName) {
                    case "NumberOfBackupJobsFailed":
                    case "NumberOfBackupJobsCreated":
                        a.Dimensions?.map(d => d.Name).should.deepEqual(["BackupVaultName"])
                        break;
                    default:
                        throw new Error("Unhandled or incorrect MetricName: " + a.MetricName);

                }
                break;
            case "Frontend":
            case "LogFilters":
            case "EmsApi":
                // custom metrics, can't easily test here
                break;
            default:
                if (a.TreatMissingData === "breaching") {
                    // no need to explicitly check the alarm in this case -- missing data
                    // will fire the alarm
                } else {
                    throw new Error("Unhandled Namespace: " + a.Namespace);
                }
        }
    }

    async function assertEventRuleExists(ruleName: string) {
        const ruleNames: string[] = await withFileCache("eventRuleNames.json", async () => {
            const client = new EventBridgeClient({});
            const command = new ListRulesCommand({});
            const data = await client.send(command);
            if (data.NextToken) {
                throw new Error("pagination")
            }

            return data.Rules!.map(r => r.Name!)
        });
        ruleNames.should.containEql(ruleName)
    }

    function getDim(dimensions: Dimension[], name: string) {
        return dimensions.find(d => d.Name === name)!.Value!
    }

    async function assertSQSQueueNameExists(queueName: string) {
        const queueNames: string[] = await withFileCache("queueNames.json", async () => {
            const sqsClient = new SQSClient({});
            const command = new ListQueuesCommand({});
            const data = await sqsClient.send(command);
            if (data.NextToken) {
                throw new Error("pagination")
            }

            return data.QueueUrls!
                .map(url => url.replace(/.*\/(.*)/, "$1"))
        });
        queueNames.should.containEql(queueName)
    }


    async function assertDBInstanceIdentifierExists(dBInstanceIdentifier: string) {
        const dbInstanceIds: string[] = await withFileCache("dBInstanceIdentifiers.json", async () => {
            const client = new RDSClient({});
            const command = new DescribeDBInstancesCommand({});
            const data = await client.send(command);
            if (data.Marker) {
                throw new Error("pagination")
            }

            return data.DBInstances!
                .map(d => d.DBInstanceIdentifier!)
        });
        dbInstanceIds.should.containEql(dBInstanceIdentifier)
    }

    async function assertApiRestGatewayExists(apiName: string) {
        const apiNames: string[] = await withFileCache("apiRestGatewayNames.json", async () => {
            const client = new APIGatewayClient({});
            const command = new GetRestApisCommand({});
            const data = await client.send(command);
            if (data.position) {
                throw new Error("pagination")
            }

            return data.items!
                .map(d => d.name!)
        });
        apiNames.should.containEql(apiName)
    }

    async function assertApiHttpGatewayExists(apiId: string) {
        const apiIds: string[] = await withFileCache("apiHttpGatewayApiIds.json", async () => {
            const client = new ApiGatewayV2Client({});
            const command = new GetApisCommand({});
            const data = await client.send(command);
            if (data.NextToken) {
                throw new Error("pagination")
            }

            return data.Items!
                .map(d => d.ApiId!)
        });
        apiIds.should.containEql(apiId)
    }

    async function assertTargetGroupExists(loadBalancer: string, targetGroup: string) {
        const targetGroups = await withFileCache("targetGroups.json", async () => {
            const client = new ElasticLoadBalancingV2Client({});
            const command = new DescribeTargetGroupsCommand({});
            const data = await client.send(command);
            if (data.NextMarker) {
                throw new Error("pagination")
            }

            return data.TargetGroups!
        });
        const matchedGroup = targetGroups.find(tg => {
            return tg.TargetGroupArn!.endsWith(targetGroup)
                && tg.LoadBalancerArns!.length == 1
                && tg.LoadBalancerArns![0].endsWith(loadBalancer)
        })
        targetGroups.should.containEql(matchedGroup)
    }

    async function assertDynamoDbTableNameExists(name: string) {
        const tableNames = await withFileCache("ddbTables.json", async () => {
            const client = new DynamoDBClient({});
            const command = new ListTablesCommand({});
            const data = await client.send(command);
            if (data.LastEvaluatedTableName) {
                throw new Error("pagination")
            }

            return data.TableNames!
        });
        tableNames.should.containEql(name)
    }

    async function assertCloudFrontDistroExists(distributionId: string) {
        const distributionIds = await withFileCache("cloudFrontDistros.json", async () => {
            const client = new CloudFrontClient({});
            const command = new ListDistributionsCommand({});
            const data = await client.send(command);
            if (data.DistributionList!.NextMarker) {
                throw new Error("pagination")
            }

            return data.DistributionList!.Items!.map(i => i.Id)
        });
        distributionIds.should.containEql(distributionId)
    }
})
