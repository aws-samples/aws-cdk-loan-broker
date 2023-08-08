import * as path from "path";

import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { SnsEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { EventBus } from "aws-cdk-lib/aws-events";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import {ContentFilter, MessageFilter, MessageContentFilter} from "./integration-patterns";


/**
 * Environment as specified by the lambda.Function environment
 */
class environment {
    [key: string]: string;
}


/**
 * Interface for the bank function environment.
 * It contains all the necessary environment variables for the bank functionality.
 */
interface BankFunctionEnvironment extends environment {
    BANK_ID: string;
    BASE_RATE: string;
    MAX_LOAN_AMOUNT: string;
    MIN_CREDIT_SCORE: string;
}


/**
 * CDK Stack implementation of the Loan broker pub sub,
 * see https://www.enterpriseintegrationpatterns.com/ramblings/loanbroker_stepfunctions_pubsub.html
 */
export class LoanBrokerPubSubStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);


        // Set up credit bureau lambda
        const creditBureauLambda = new lambda.Function(this, "CreditBureauLambda", {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: "app.handler",
            code: lambda.Code.fromAsset("credit-bureau"),
            functionName: "CreditBureauLambda-PubSub",
        });

        // Setup get credit score from credit bureau task
        const getCreditScoreFromCreditBureau = new tasks.LambdaInvoke(this, "Get Credit Score from credit bureau", {
            lambdaFunction: creditBureauLambda,
            payload: sfn.TaskInput.fromObject({
                "SSN.$": "$.SSN",
                "RequestId.$": "$$.Execution.Id",
            }),
            resultPath: "$.Credit",
            resultSelector: {
                "Score.$": "$.Payload.body.score",
                "History.$": "$.Payload.body.history",
            },
            retryOnServiceExceptions: false, // This is just for development purposes
        });

        // Setup mortgage event bus, to route mortgage quotes
        const mortgageQuotesEventBus = new EventBus(this, "MortgageQuotesEventBus", {
            eventBusName: "MortgageQuotesEventBus",
        });

        const mortgageQuotesQueue = new sqs.Queue(this, "MortgageQuotesQueue", {
            retentionPeriod: Duration.minutes(5),

            removalPolicy: RemovalPolicy.DESTROY, // This is just for development purposes
        });

        // Setup message and content filter for mortgage quotes
        var nonEmptyQuoteMessageFilter = MessageFilter.fieldExists(this, "nonEmptyQuoteMessageFilter", "bankId");
        var payloadContentFilter = ContentFilter.createPayloadFilter(this, "PayloadContentFilter");

        new MessageContentFilter(this, "FilterMortgageQuotes", {
            sourceEventBus: mortgageQuotesEventBus,
            targetQueue: mortgageQuotesQueue,
            messageFilter: nonEmptyQuoteMessageFilter,
            contentFilter: payloadContentFilter,
        });

        // Set up the different banks
        const bankRecipientPawnshop = this._createBankFunction({
            bankName: "BankRecipientPawnshop",
            destinationEventBus: mortgageQuotesEventBus,
            bankConfiguration: {
                BANK_ID: "PawnShop",
                BASE_RATE: "5",
                MAX_LOAN_AMOUNT: "500000",
                MIN_CREDIT_SCORE: "400",
            },
        });

        const bankRecipientUniversal = this._createBankFunction({
            bankName: "BankRecipientUniversal",
            destinationEventBus: mortgageQuotesEventBus,
            bankConfiguration: {
                BANK_ID: "Universal",
                BASE_RATE: "4",
                MAX_LOAN_AMOUNT: "700000",
                MIN_CREDIT_SCORE: "500",
            },
        });

        const bankRecipientPremium = this._createBankFunction({
            bankName: "BankRecipientPremium",
            destinationEventBus: mortgageQuotesEventBus,
            bankConfiguration: {
                BANK_ID: "Premium",
                BASE_RATE: "3",
                MAX_LOAN_AMOUNT: "900000",
                MIN_CREDIT_SCORE: "600",
            },
        });

        // Set up the mortgage quote request topic
        const mortgageQuoteRequestTopic = new sns.Topic(this, "MortgageQuoteRequest", {
            displayName: "MortgageQuoteRequest topic",
        });

        // Add all banks to the mortgage quote request topic
        [bankRecipientPawnshop, bankRecipientUniversal, bankRecipientPremium]
          .forEach((bank) => {
            bank.addEventSource(new SnsEventSource(mortgageQuoteRequestTopic));
        });

        // Setup mortgage quotes table
        const mortgageQuotesTable = new dynamodb.Table(this, "MortgageQuotesTable", {
            partitionKey: { name: "Id", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: "MortgageQuotesTable",

            removalPolicy: RemovalPolicy.DESTROY, // This is just for development purposes
        });

        // Set up quote aggregator lambda
        const quoteAggregatorLambda = new NodejsFunction(this, "QuoteAggregatorLambda", {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: "handler",
            entry: path.join(__dirname, "../quote-aggregator/app.js"),
            functionName: "QuoteAggregator",
            environment: {
                MORTGAGE_QUOTES_TABLE: mortgageQuotesTable.tableName,
            },
        });

        quoteAggregatorLambda.addEventSource(
            new SqsEventSource(mortgageQuotesQueue, {
                batchSize: 10,
            })
        );

        mortgageQuotesQueue.grantConsumeMessages(quoteAggregatorLambda);
        mortgageQuotesTable.grantWriteData(quoteAggregatorLambda);

        // Request mortgage quotes from all banks custom state (get function name at runtime from state input is currently not natively supported by the CDK)
        const requestMortgageQuotesFromAllBanks = new tasks.SnsPublish(this, "Request mortgage quotes from all banks", {
            topic: mortgageQuoteRequestTopic,
            message: sfn.TaskInput.fromObject({
                taskToken: sfn.JsonPath.taskToken,
                input: sfn.JsonPath.entirePayload,
                context: sfn.JsonPath.entireContext,
            }),
            resultPath: "$.Quotes",
            integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,

            timeout: Duration.seconds(5),
        });

        const getMortgageQuotesLambda = new NodejsFunction(this, "GetMortgageQuotesLambda", {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: "handler",
            entry: path.join(__dirname, "../quote-requester/app.js"),
            functionName: "QuoteRequester",
            environment: {
                MORTGAGE_QUOTES_TABLE: mortgageQuotesTable.tableName,
            },
        });
        mortgageQuotesTable.grantReadData(getMortgageQuotesLambda);

        // TODO: Replace with DynamoDB Get Item call
        // Setup get mortgage quotes task
        const getMortgageQuotes = new tasks.LambdaInvoke(this, "Get Mortgage Quotes", {
            lambdaFunction: getMortgageQuotesLambda,
            payload: sfn.TaskInput.fromObject({
                "Id.$": "$$.Execution.Id",
            }),
            resultPath: "$.result",
            resultSelector: {
                "Quotes.$": "$.Payload.quotes",
            },

            retryOnServiceExceptions: false, // This is just for development purposes
        });

        // Setup transformation of the result
        const transformMortgageQuotesResponse = new sfn.Pass(this, "Transform Mortgage Quotes Response", {
            parameters: {
                "SSN.$": "$.SSN",
                "Amount.$": "$.Amount",
                "Term.$": "$.Term",
                "Credit.$": "$.Credit",
                "Quotes.$": "$.result.Quotes",
            },
        });

        const loanBrokerDefinition =
          getCreditScoreFromCreditBureau
            .next(requestMortgageQuotesFromAllBanks
              .addCatch(getMortgageQuotes
                .next(transformMortgageQuotesResponse),
                {
                  errors: ["States.Timeout"],
                  resultPath: "$.Error",
                }
              )
            );

        const loanBrokerLogGroup = new logs.LogGroup(this, "LoanBrokerLogGroup");

        const loanBroker = new sfn.StateMachine(this, "LoanBroker", {
            definitionBody: sfn.DefinitionBody.fromChainable(loanBrokerDefinition),

            stateMachineType: sfn.StateMachineType.STANDARD,
            timeout: Duration.minutes(5),
            logs: {
                destination: loanBrokerLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
            tracingEnabled: true,
        });

        mortgageQuoteRequestTopic.grantPublish(loanBroker);
        loanBroker.grantTaskResponse(quoteAggregatorLambda);

        new CfnOutput(this, "LoanBrokerArn", {
            value: loanBroker.stateMachineArn,
        });
    }

    /**
     * Creates a bank lambda function.
     *
     * @param name Name of the bank
     * @param env The environment configurations of the bank
     * @para
     * @returns A bank Lambda function
     */
    private _createBankFunction(config: {
        bankName: string;
        bankConfiguration: BankFunctionEnvironment;
        destinationEventBus: EventBus;
    }) {
        return new lambda.Function(this, config.bankName, {
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: "app-sns.handler",
            code: lambda.Code.fromAsset("bank"),
            functionName: config.bankName + "-PubSub",
            environment: config.bankConfiguration,

            onSuccess: new destinations.EventBridgeDestination(config.destinationEventBus),
        });
    }
}
