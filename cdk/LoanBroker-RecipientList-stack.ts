import * as cdk from "@aws-cdk/core";
import * as lambda from "@aws-cdk/aws-lambda";
import * as sfn from "@aws-cdk/aws-stepfunctions";
import * as tasks from "@aws-cdk/aws-stepfunctions-tasks";
import * as logs from "@aws-cdk/aws-logs";
import * as dynamodb from "@aws-cdk/aws-dynamodb";
import { Duration } from "@aws-cdk/core";


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
 * CDK Stack implementation of the Loan broker recipient list,
 * see https://www.enterpriseintegrationpatterns.com/ramblings/loanbroker_stepfunctions_recipient_list.html
 */
export class LoanBrokerRecipientListStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);


        // Set up credit bureau lambda
        const creditBureauLambda = new lambda.Function(this, "CreditBureauLambda", {
            runtime: lambda.Runtime.NODEJS_14_X,
            handler: "app.handler",
            code: lambda.Code.fromAsset("credit-bureau"),
            functionName: "CreditBureauLambda",
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

        // Setup loan broker bank table
        const loanBrokerBankTable = new dynamodb.Table(this, "LoanBrokerBanksTable", {
            partitionKey: { name: "Type", type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            tableName: "LoanBrokerBanksTable",

            removalPolicy: cdk.RemovalPolicy.DESTROY, // This is just for development purposes
        });

        // Setup fetch bank addresses from database task
        const fetchBankAddressesFromDatabase = new tasks.DynamoGetItem(this, "Fetch Bank Addresses from database", {
            table: loanBrokerBankTable,
            key: { Type: tasks.DynamoAttributeValue.fromString("Home") },
            resultPath: "$.Banks",
            resultSelector: {
                "BankAddress.$": "$.Item.BankAddress.L[*].S",
            },
        });

        // Get individual bank quotes custom state (get function name at runtime from state input is currently not natively supported by the CDK)
        const getIndividualBankQuotes = new sfn.CustomState(this, "Get individual bank quotes", {
            stateJson: {
                Type: "Task",
                Resource: "arn:aws:states:::lambda:invoke",
                Parameters: {
                    "FunctionName.$": "$.function",
                    Payload: {
                        "SSN.$": "$.SSN",
                        "Amount.$": "$.Amount",
                        "Term.$": "$.Term",
                        "Credit.$": "$.Credit",
                    },
                },
                ResultSelector: {
                    "Quote.$": "$.Payload",
                },
            },
        });

        // Get all bank quotes, this will iterator over all banks
        const getAllBankQuotes = new sfn.Map(this, "Get all bank quotes", {
            itemsPath: "$.Banks.BankAddress",
            parameters: {
                "function.$": "$$.Map.Item.Value",
                "SSN.$": "$.SSN",
                "Amount.$": "$.Amount",
                "Term.$": "$.Term",
                "Credit.$": "$.Credit",
            },
            resultPath: "$.Quotes",
        });

        const loanBrokerDefinition =
          getCreditScoreFromCreditBureau
            .next(fetchBankAddressesFromDatabase)
            .next(getAllBankQuotes
              .iterator(getIndividualBankQuotes));

        const loanBrokerLogGroup = new logs.LogGroup(this, "LoanBrokerLogGroup");

        const loanBroker = new sfn.StateMachine(this, "LoanBroker", {
            definition: loanBrokerDefinition,

            stateMachineType: sfn.StateMachineType.STANDARD,
            timeout: Duration.minutes(5),
            logs: {
                destination: loanBrokerLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
            tracingEnabled: true,
        });

        // Set up the different banks
        const bankRecipientPawnshop = this._createBankFunction("BankRecipientPawnshop", {
            BANK_ID: "PawnShop",
            BASE_RATE: "5",
            MAX_LOAN_AMOUNT: "500000",
            MIN_CREDIT_SCORE: "400",
        });

        const bankRecipientUniversal = this._createBankFunction("BankRecipientUniversal", {
            BANK_ID: "Universal",
            BASE_RATE: "4",
            MAX_LOAN_AMOUNT: "700000",
            MIN_CREDIT_SCORE: "500",
        });

        const bankRecipientPremium = this._createBankFunction("BankRecipientPremium", {
            BANK_ID: "Premium",
            BASE_RATE: "3",
            MAX_LOAN_AMOUNT: "900000",
            MIN_CREDIT_SCORE: "600",
        });

        [bankRecipientPawnshop, bankRecipientPremium, bankRecipientUniversal].forEach((bank) =>
            bank.grantInvoke(loanBroker)
        );

        new cdk.CfnOutput(this, "LoanBrokerArn", {
            value: loanBroker.stateMachineArn,
        });
    }


    /**
     * Creates a bank lambda function.
     *
     * @param name Name of the bank
     * @param env The environment configurations of the bank
     * @returns A bank Lambda function
     */
    private _createBankFunction(name: string, env: BankFunctionEnvironment) {
        return new lambda.Function(this, name, {
            runtime: lambda.Runtime.NODEJS_14_X,
            handler: "app.handler",
            code: lambda.Code.fromAsset("bank"),
            functionName: name,
            environment: env,
        });
    }
}
