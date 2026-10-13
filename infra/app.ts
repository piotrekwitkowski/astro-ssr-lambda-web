// Astro SSR on a Lambda Web Function behind CloudFront with origin access control.
// Node 24 runs this file directly (type stripping), so `cdk` needs no TypeScript build step.
import { fileURLToPath } from 'node:url';
import { App, Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cr from 'aws-cdk-lib/custom-resources';

// The function and its session table run in these three Regions. The first is the home Region,
// where the stack and the function's control plane live. The list can't change after the endpoint
// exists. Avoid opt-in Regions: CloudFront can't sign requests routed to them.
const [homeRegion, ...replicaRegions] = ['eu-west-1', 'us-east-1', 'ap-northeast-1'];

const app = new App();
const stack = new Stack(app, 'AstroSsrLambdaWeb', {
	env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: homeRegion },
});
const name = 'astro-ssr-lambda-web';

// Astro.session storage. A global table with a replica next to every copy of the function.
const sessions = new dynamodb.TableV2(stack, 'Sessions', {
	partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
	replicas: replicaRegions.map((region) => ({ region })),
	removalPolicy: RemovalPolicy.DESTROY,
});

const role = new iam.Role(stack, 'ExecutionRole', {
	assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
	managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
});
sessions.grantReadWriteData(role);
// Each copy of the function writes to the replica in its own Region, and every replica has its own ARN.
for (const region of replicaRegions) sessions.replica(region).grantReadWriteData(role);

// Lambda reads Web Function code from a versioned bucket, with its own service principal.
const codeBucket = new s3.Bucket(stack, 'CodeBucket', {
	versioned: true,
	enforceSSL: true,
	removalPolicy: RemovalPolicy.DESTROY,
	autoDeleteObjects: true,
});
codeBucket.addToResourcePolicy(
	new iam.PolicyStatement({
		principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
		actions: ['s3:GetObject', 's3:GetObjectVersion'],
		resources: [codeBucket.arnForObjects('*')],
		conditions: {
			ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:web-function/${name}/revision/*` },
		},
	}),
);

// `npm run package` stages server.ts and dist/ in .deploy/. Dependencies are bundled into dist/server.
// Keep old packages (prune: false): a revision fails for good if its code object is deleted.
const code = new s3deploy.BucketDeployment(stack, 'Code', {
	sources: [s3deploy.Source.asset(fileURLToPath(new URL('../.deploy', import.meta.url)))],
	destinationBucket: codeBucket,
	extract: false,
	prune: false,
});

const fn = new lambda.CfnWebFunction(stack, 'WebFunction', { functionName: name });

// Revisions are immutable, so a code or configuration change creates a new one.
const revision = new lambda.CfnWebFunctionRevision(stack, 'Revision', {
	functionName: fn.ref,
	buildConfig: {
		codeConfig: { s3Object: { bucket: codeBucket.bucketName, key: Fn.select(0, code.objectKeys) } },
		runtimeConfig: { runtime: 'nodejs24.x' },
	},
	serviceConfig: {
		executionRoleArn: role.roleArn,
		environmentVariables: {
			AWS_LAMBDA_NODEJS_ENTRYPOINT: 'server.ts',
			SESSION_TABLE: sessions.tableName,
			DEBUG_HEADERS: app.node.tryGetContext('debugHeaders') === 'true' ? '1' : '0',
		},
	},
});
revision.node.addDependency(codeBucket.policy!);

// One global domain that routes each request to the lowest-latency Region. IamAuth: the endpoint
// rejects anything that isn't signed by a principal the resource policy allows.
const endpoint = new lambda.CfnWebFunctionEndpoint(stack, 'Endpoint', {
	functionName: fn.ref,
	endpointName: 'prod',
	endpointType: 'MultiRegion',
	regions: replicaRegions,
	authType: 'IamAuth',
	revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
});

// Web Function origins accept only the always-amz-auth signing behavior. CloudFront signs in a
// separate header and passes the viewer's Authorization header through. The global endpoint needs
// SigV4a. Neither is in the L2 constructs yet.
const oac = new cloudfront.CfnOriginAccessControl(stack, 'OriginAccessControl', {
	originAccessControlConfig: {
		name,
		originAccessControlOriginType: 'lambda',
		signingBehavior: 'always-amz-auth',
		signingProtocol: 'sigv4a',
	},
});

const origin = new origins.HttpOrigin(endpoint.attrDomainName, {
	originAccessControlId: oac.attrId,
});

const viewerRequest = new cloudfront.Function(stack, 'ViewerRequest', {
	code: cloudfront.FunctionCode.fromFile({ filePath: fileURLToPath(new URL('viewer-request.js', import.meta.url)) }),
	runtime: cloudfront.FunctionRuntime.JS_2_0,
});

// Server-rendered pages: cache only what the app marks cacheable with Cache-Control, and compress.
// CachingDisabled would also turn compression off.
const pages = new cloudfront.CachePolicy(stack, 'Pages', {
	defaultTtl: Duration.seconds(0),
	minTtl: Duration.seconds(0),
	maxTtl: Duration.days(365),
	queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
	enableAcceptEncodingGzip: true,
	enableAcceptEncodingBrotli: true,
});

const distribution = new cloudfront.Distribution(stack, 'Distribution', {
	comment: name,
	defaultBehavior: {
		origin,
		viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
		allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
		cachePolicy: pages,
		// The endpoint routes on Host, so the viewer's Host must not reach it.
		originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
		functionAssociations: [{ function: viewerRequest, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
	},
	additionalBehaviors: {
		// Fingerprinted build assets.
		'/_astro/*': {
			origin,
			viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
			cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
		},
	},
});

// CloudFormation can't set a Web Function resource policy yet, so call PutResourcePolicy directly.
const functionArn = fn.attrFunctionArn;
new cr.AwsCustomResource(stack, 'ResourcePolicy', {
	installLatestAwsSdk: true,
	onUpdate: {
		service: '@aws-sdk/client-lambda-web',
		action: 'PutResourcePolicy',
		parameters: {
			resourceArn: functionArn,
			policy: stack.toJsonString({
				Version: '2012-10-17',
				Statement: [
					{
						Effect: 'Allow',
						Principal: { Service: 'cloudfront.amazonaws.com' },
						Action: 'lambda:InvokeWebFunctionEndpoint',
						Resource: endpoint.attrEndpointArn,
						Condition: { StringEquals: { 'aws:SourceArn': distribution.distributionArn } },
					},
				],
			}),
		},
		physicalResourceId: cr.PhysicalResourceId.of(`${name}-resource-policy`),
	},
	onDelete: {
		service: '@aws-sdk/client-lambda-web',
		action: 'DeleteResourcePolicy',
		parameters: { resourceArn: functionArn },
	},
	policy: cr.AwsCustomResourcePolicy.fromStatements([
		new iam.PolicyStatement({
			actions: ['lambda:PutResourcePolicy', 'lambda:DeleteResourcePolicy'],
			resources: [functionArn],
		}),
	]),
});

new CfnOutput(stack, 'Url', { value: `https://${distribution.distributionDomainName}` });
new CfnOutput(stack, 'EndpointDomain', { value: endpoint.attrDomainName });
