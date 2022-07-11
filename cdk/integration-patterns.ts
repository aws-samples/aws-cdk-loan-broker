import { Construct } from "constructs";
import { IQueue } from "aws-cdk-lib/aws-sqs";
import { EventBus, Rule, RuleTargetInput, EventPattern } from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";

export interface ContentFilterProps {
  readonly jsonPath: string;
}

export class ContentFilter extends Construct {
  public readonly ruleTargetInput: RuleTargetInput;

  constructor(scope: Construct, id: string, props: ContentFilterProps) {
    super(scope, id);

    this.ruleTargetInput = RuleTargetInput.fromEventPath(props.jsonPath);
  }

  static createPayloadFilter(scope: Construct, id: string): ContentFilter {
    return new ContentFilter(scope, id, {
      jsonPath: "$.detail.responsePayload",
    });
  }
}

export interface MessageFilterProps extends EventPattern {}

export class MessageFilter extends Construct {
  public readonly eventPattern: EventPattern;

  constructor(scope: Construct, id: string, props: MessageFilterProps) {
    super(scope, id);

    this.eventPattern = props;
  }

  static fieldExists(scope: Construct, id: string, fieldToCheck: string): MessageFilter {
    return new MessageFilter(scope, id, {
      detail: {
        responsePayload: { [fieldToCheck]: [{ exists: true }] },
      },
    });
  }
}

export interface MessageContentFilterProps {
  sourceEventBus: EventBus;
  targetQueue: IQueue;
  messageFilter: MessageFilter;
  contentFilter: ContentFilter;
}

export class MessageContentFilter extends Construct {
  constructor(scope: Construct, id: string, props: MessageContentFilterProps) {
    super(scope, id);

    const messageFilterRule = new Rule(scope, id + "Rule", {
      eventBus: props.sourceEventBus,
      ruleName: id + "Rule",
      eventPattern: props.messageFilter.eventPattern,
    });

    var queueMessageProps = props.contentFilter.ruleTargetInput
      ? {
          message: props.contentFilter.ruleTargetInput,
        }
      : {};
    messageFilterRule.addTarget(new targets.SqsQueue(props.targetQueue, queueMessageProps));
  }
}
