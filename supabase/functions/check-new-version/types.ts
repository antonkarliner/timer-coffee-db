// supabase/functions/check-new-version/types.ts

// Interface for App Store Connect List Apps Response
export interface AppStoreListAppsResponse {
    data: AppStoreApp[];
    links: {
      self: string;
      next?: string;
    };
    meta: {
      paging: {
        total: number;
        limit: number;
      };
    };
  }
  
  export interface AppStoreApp {
    type: string;
    id: string;
    attributes: {
      name: string;
      bundleId: string;
      sku: string;
      primaryLocale: string;
      isOrEverWasMadeForKids: boolean;
      contentRightsDeclaration: string;
      streamlinedBuyEnabled: boolean;
      // Add other attributes as needed
    };
    relationships: AppStoreAppRelationships;
    links: {
      self: string;
    };
  }
  
  export interface AppStoreAppRelationships {
    appEncryptionDeclarations?: RelationshipLinks;
    ciProduct?: RelationshipLinks;
    betaTesters?: RelationshipLinks;
    betaGroups?: RelationshipLinks;
    appStoreVersions?: RelationshipLinks;
    preReleaseVersions?: RelationshipLinks;
    betaAppLocalizations?: RelationshipLinks;
    builds?: RelationshipLinks;
    betaLicenseAgreement?: RelationshipLinks;
    betaAppReviewDetail?: RelationshipLinks;
    appInfos?: RelationshipLinks;
    appClips?: RelationshipLinks;
    appPricePoints?: RelationshipLinks;
    endUserLicenseAgreement?: RelationshipLinks;
    preOrder?: RelationshipLinks;
    appPriceSchedule?: RelationshipLinks;
    appAvailability?: RelationshipLinks;
    appAvailabilityV2?: RelationshipLinks;
    inAppPurchases?: RelationshipLinks;
    subscriptionGroups?: RelationshipLinks;
    gameCenterEnabledVersions?: RelationshipLinks;
    perfPowerMetrics?: RelationshipLinks;
    appCustomProductPages?: RelationshipLinks;
    inAppPurchasesV2?: RelationshipLinks;
    promotedPurchases?: RelationshipLinks;
    appEvents?: RelationshipLinks;
    reviewSubmissions?: RelationshipLinks;
    subscriptionGracePeriod?: RelationshipLinks;
    customerReviews?: RelationshipLinks;
    gameCenterDetail?: RelationshipLinks;
    appStoreVersionExperimentsV2?: RelationshipLinks;
    alternativeDistributionKey?: RelationshipLinks;
    analyticsReportRequests?: RelationshipLinks;
    marketplaceSearchDetail?: RelationshipLinks;
  }
  
  export interface RelationshipLinks {
    links: {
      self: string;
      related: string;
    };
  }
  
  // Interface for App Store Connect appStoreVersions Response
  export interface AppStoreVersionResponse {
    data: AppStoreVersion[];
    links: {
      self: string;
      next?: string;
    };
    meta: {
      paging: {
        total: number;
        limit: number;
      };
    };
  }
  
  export interface AppStoreVersion {
    type: string;
    id: string;
    attributes: {
      platform: string;
      versionString: string;
      appStoreState: string;
      // Add other attributes if needed
    };
    relationships: Record<string, never>; // No relationships needed for this response
    links: {
      self: string;
    };
  }
  
  // Interface for Google Play Version
  export interface GooglePlayVersion {
    versionName: string;
    versionCode: number;
  }
  